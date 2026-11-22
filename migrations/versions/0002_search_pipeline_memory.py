"""Add search, worker, revision, graph, and decision storage."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector

revision: str = "0002_search_pipeline_memory"
down_revision: str | None = "0001_create_items"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.create_table(
        "item_revisions",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("item_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=500), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("metadata", sa.JSON(), server_default="{}", nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["item_id"], ["items.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("item_id", "version"),
    )
    op.create_index("ix_item_revisions_item_id", "item_revisions", ["item_id"])

    op.create_table(
        "chunks",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("item_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("embedding", Vector(384), nullable=True),
        sa.Column("embedding_model", sa.String(length=128), nullable=True),
        sa.ForeignKeyConstraint(["item_id"], ["items.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("item_id", "chunk_index"),
    )
    op.create_index("ix_chunks_item_id", "chunks", ["item_id"])
    op.create_index(
        "ix_chunks_text_fts",
        "chunks",
        [sa.text("to_tsvector('english', text)")],
        postgresql_using="gin",
    )
    op.create_index(
        "ix_items_title_fts",
        "items",
        [sa.text("to_tsvector('english', title)")],
        postgresql_using="gin",
    )
    op.create_index(
        "ix_chunks_embedding_hnsw",
        "chunks",
        ["embedding"],
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )

    op.create_table(
        "edges",
        sa.Column("src_item_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("dst_item_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("score", sa.Float(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["src_item_id"], ["items.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["dst_item_id"], ["items.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("src_item_id", "dst_item_id", "kind"),
    )
    op.create_index("ix_edges_dst_item_id", "edges", ["dst_item_id"])

    op.create_table(
        "decisions",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("item_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("question", sa.String(length=1000), nullable=False),
        sa.Column("choice", sa.Text(), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("revisit_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("outcome", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["item_id"], ["items.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_decisions_item_id", "decisions", ["item_id"])

    op.create_table(
        "jobs",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column(
            "run_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_jobs_status_run_at", "jobs", ["status", "run_at"])

    op.create_index("ix_items_captured_at", "items", ["captured_at"])
    op.execute(
        """
        INSERT INTO jobs (id, kind, payload, status, attempts)
        SELECT gen_random_uuid(), 'index_item', json_build_object('item_id', id::text), 'pending', 0
        FROM items
        """
    )


def downgrade() -> None:
    op.drop_index("ix_items_captured_at", table_name="items")
    op.drop_index("ix_items_title_fts", table_name="items")
    op.drop_index("ix_jobs_status_run_at", table_name="jobs")
    op.drop_table("jobs")
    op.drop_index("ix_decisions_item_id", table_name="decisions")
    op.drop_table("decisions")
    op.drop_index("ix_edges_dst_item_id", table_name="edges")
    op.drop_table("edges")
    op.drop_index("ix_chunks_embedding_hnsw", table_name="chunks")
    op.drop_index("ix_chunks_text_fts", table_name="chunks")
    op.drop_index("ix_chunks_item_id", table_name="chunks")
    op.drop_table("chunks")
    op.drop_index("ix_item_revisions_item_id", table_name="item_revisions")
    op.drop_table("item_revisions")
