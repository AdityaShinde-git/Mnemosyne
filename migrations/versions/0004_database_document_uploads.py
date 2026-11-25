"""Persist uploaded document files in the database."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_database_document_uploads"
down_revision: str | None = "0003_spaces_and_named_edges"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("source_data", sa.LargeBinary(), nullable=True))
    op.create_table(
        "document_files",
        sa.Column("item_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=255), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.ForeignKeyConstraint(["item_id"], ["items.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("item_id"),
    )


def downgrade() -> None:
    op.drop_table("document_files")
    op.drop_column("jobs", "source_data")
