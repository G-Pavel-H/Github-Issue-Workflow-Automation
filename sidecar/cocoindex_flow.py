"""Tsukinome code-index sidecar (Phase 6).

The real engine behind the TypeScript ``CodeIndex`` interface. It uses CocoIndex to
AST-chunk a repo checkout (tree-sitter), embed each chunk with a *local* SentenceTransformer
model (no API key, ~$0), and write the rows into our ``code_chunks`` table tagged with a
per-run ``namespace``. A ``query-embed`` mode embeds a query string with the *same* model so
retrieval (done in TS against pgvector) shares the document vector space.

This is the one Phase-6 piece that runs only where Python + CocoIndex are installed — it is
exercised by the gated integration test and the ``debug:index-repo`` demo, never in CI
(mirroring how ``e2b-sandbox.ts`` is verified against the live service, not in CI). The exact
CocoIndex API surface is confirmed during that gated run.

Usage:
    python cocoindex_flow.py index --namespace <ns> --dir <repo_dir> [--model <hf_model>]
    python cocoindex_flow.py query-embed --query "<text>" [--model <hf_model>]

Env: DATABASE_URL must point at the pgvector-enabled Postgres (same DB as the app).
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import cocoindex

DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"

# Source files we index. Keep in sync with the fake index's SOURCE_EXT (TS/JS for the MVP).
INCLUDED_GLOBS = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mts", "**/*.cts"]
EXCLUDED_GLOBS = ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/coverage/**"]


def _embed(text: cocoindex.DataSlice, model: str) -> cocoindex.DataSlice:
    """Shared embedding transform — used for both documents and queries (same space)."""
    return text.transform(
        cocoindex.functions.SentenceTransformerEmbed(model=model)
    )


def build_flow(namespace: str, repo_dir: str, model: str):
    """Define the indexing flow: LocalFile -> tree-sitter split -> embed -> Postgres."""

    @cocoindex.flow_def(name=f"TsukinomeCodeIndex_{abs(hash(namespace))}")
    def code_index_flow(flow_builder: cocoindex.FlowBuilder, data_scope: cocoindex.DataScope):
        data_scope["files"] = flow_builder.add_source(
            cocoindex.sources.LocalFile(
                path=repo_dir,
                included_patterns=INCLUDED_GLOBS,
                excluded_patterns=EXCLUDED_GLOBS,
            )
        )

        chunks = data_scope.add_collector()
        with data_scope["files"].row() as file:
            # AST-aware chunking keeps whole functions/classes intact (complete units).
            file["chunks"] = file["content"].transform(
                cocoindex.functions.SplitRecursively(),
                language="typescript",
                chunk_size=1200,
                chunk_overlap=120,
            )
            with file["chunks"].row() as chunk:
                chunk["embedding"] = _embed(chunk["text"], model)
                chunks.collect(
                    namespace=namespace,
                    path=file["filename"],
                    start_line=chunk["location"].start.line,
                    end_line=chunk["location"].end.line,
                    content=chunk["text"],
                    embedding=chunk["embedding"],
                )

        # Write into our existing per-run table; retrieval + teardown are owned in TS.
        chunks.export(
            "code_chunks",
            cocoindex.targets.Postgres(table_name="code_chunks"),
            primary_key_fields=["namespace", "path", "start_line"],
        )

    return code_index_flow


def cmd_index(args: argparse.Namespace) -> int:
    cocoindex.init()
    flow = build_flow(args.namespace, args.dir, args.model)
    # One-shot (non-incremental) update for this run.
    flow.update()
    return 0


def cmd_query_embed(args: argparse.Namespace) -> int:
    """Embed a query with the same local model; print the vector as JSON to stdout."""
    from sentence_transformers import SentenceTransformer

    vec = SentenceTransformer(args.model).encode(args.query).tolist()
    json.dump(vec, sys.stdout)
    return 0


def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        print("DATABASE_URL is required", file=sys.stderr)
        return 2

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
