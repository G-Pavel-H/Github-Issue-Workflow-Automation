"""Tsukinome code-index sidecar (Phase 6).

The real engine behind the TypeScript ``CodeIndex`` interface. It uses CocoIndex's tree-sitter
``RecursiveSplitter`` to AST-chunk a repo checkout (whole functions/classes stay intact), embeds
each chunk with a *local* SentenceTransformer model (no API key, ~$0), and writes the rows into
our ``code_chunks`` table tagged with a per-run ``namespace``. A ``query-embed`` mode embeds a
query string with the *same* model so retrieval (done in TS against pgvector) shares the document
vector space.

Design note (CocoIndex 1.0): 1.0 replaced the declarative ``flow_def`` / ``sources`` / ``targets``
pipeline with a reactive component model. For our one-shot, per-run batch job we don't need that
machinery — we use CocoIndex purely for its tree-sitter chunking (its real value) and own the
walk / embed / INSERT ourselves. This keeps ``code_chunks`` owned by migration 006 (CocoIndex
never manages the table) and calls the embedding model from a plain sequential loop, off any
native parallel executor.

This is the one Phase-6 piece that runs only where Python + CocoIndex are installed — it is
exercised by the gated integration test and the ``debug:index-repo`` demo, never in CI (mirroring
how ``e2b-sandbox.ts`` is verified against the live service, not in CI).

Usage:
    python cocoindex_flow.py index --namespace <ns> --dir <repo_dir> [--model <hf_model>]
    python cocoindex_flow.py query-embed --query "<text>" [--model <hf_model>]

Env: DATABASE_URL must point at the pgvector-enabled Postgres (same DB as the app). Only the
``index`` command needs it; ``query-embed`` is DB-free.
"""

import argparse
import json
import os
import sys

# Keep tokenizer/BLAS threading calm before torch loads. Cheap insurance; the model is only
# ever called from this process's own sequential loop, never a native parallel executor.
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
# Embedding dimension of DEFAULT_MODEL (all-MiniLM-L6-v2). Must match src/index/types.ts
# EMBEDDING_DIM and the code_chunks.embedding vector(384) column (migration 006).
EMBEDDING_DIM = 384

# Target chunk size / overlap in BYTES (CocoIndex 1.0's RecursiveSplitter measures bytes).
CHUNK_SIZE = 1200
CHUNK_OVERLAP = 120

# Source file extensions we index. Keep in sync with the fake index's SOURCE_EXT (TS/JS, MVP).
SOURCE_EXT = (".ts", ".tsx", ".js", ".jsx", ".mts", ".cts")
# Directories we never descend into.
EXCLUDED_DIRS = {"node_modules", "dist", ".git", "coverage", "build", ".next"}

_MODEL = DEFAULT_MODEL
_ST_MODEL = None  # lazily-loaded SentenceTransformer, cached for the process lifetime


def _model():
    """Load (once) and return the SentenceTransformer for ``_MODEL``."""
    global _ST_MODEL
    if _ST_MODEL is None:
        from sentence_transformers import SentenceTransformer

        _ST_MODEL = SentenceTransformer(_MODEL)
    return _ST_MODEL


def _iter_source_files(root: str):
    """Yield (absolute_path, path_relative_to_root) for every indexable source file."""
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune excluded directories in place so os.walk never descends into them.
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS]
        for name in filenames:
            if name.endswith(SOURCE_EXT):
                abspath = os.path.join(dirpath, name)
                yield abspath, os.path.relpath(abspath, root)


def _to_vector_literal(values) -> str:
    """pgvector text literal, e.g. ``[0.1,0.2,...]`` — matches TS toVectorLiteral."""
    return "[" + ",".join(repr(float(v)) for v in values) + "]"


def cmd_index(args: argparse.Namespace) -> int:
    global _MODEL
    _MODEL = args.model
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL is required for `index`", file=sys.stderr)
        return 2

    import psycopg
    from cocoindex.ops.code import CodeSource
    from cocoindex.ops.text import RecursiveSplitter, detect_code_language

    splitter = RecursiveSplitter()
    model = _model()

    # Chunk every source file (AST-aware where tree-sitter knows the language), collecting
    # (path, start_line, end_line, text) so we can batch-embed and batch-insert once.
    collected: list[tuple[str, int, int, str]] = []
    for abspath, relpath in _iter_source_files(args.dir):
        try:
            with open(abspath, encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError):
            continue  # unreadable / binary-ish file — skip, don't fail the run
        if not text.strip():
            continue
        language = detect_code_language(filename=os.path.basename(abspath))
        src = CodeSource(text, language=language)
        for chunk in splitter.split(src, CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP):
            if chunk.text.strip():
                collected.append((relpath, chunk.start.line, chunk.end.line, chunk.text))

    if not collected:
        return 0

    # One batched embed call for the whole repo (shares the model with query-embed).
    embeddings = model.encode([c[3] for c in collected])

    rows = [
        (args.namespace, path, start, end, content, _to_vector_literal(vec))
        for (path, start, end, content), vec in zip(collected, embeddings)
    ]
    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO code_chunks
                       (namespace, path, start_line, end_line, content, embedding)
                   VALUES (%s, %s, %s, %s, %s, %s::vector)""",
                rows,
            )
        conn.commit()
    return 0


def cmd_query_embed(args: argparse.Namespace) -> int:
    """Embed a query with the same local model; print the vector as JSON to stdout."""
    global _MODEL
    _MODEL = args.model
    vec = _model().encode(args.query).tolist()
    json.dump(vec, sys.stdout)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Tsukinome code-index sidecar")
    sub = parser.add_subparsers(dest="command", required=True)

    p_index = sub.add_parser("index", help="chunk + embed a repo into code_chunks")
    p_index.add_argument("--namespace", required=True)
    p_index.add_argument("--dir", required=True)
    p_index.add_argument("--model", default=DEFAULT_MODEL)
    p_index.set_defaults(func=cmd_index)

    p_query = sub.add_parser("query-embed", help="embed a query string (JSON vector to stdout)")
    p_query.add_argument("--query", required=True)
    p_query.add_argument("--model", default=DEFAULT_MODEL)
    p_query.set_defaults(func=cmd_query_embed)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
