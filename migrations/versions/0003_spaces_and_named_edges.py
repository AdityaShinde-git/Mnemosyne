"""Add isolated graph spaces and labels for connections."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_spaces_and_named_edges"
down_revision: str | None = "0002_search_pipeline_memory"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DEFAULT_SPACE_ID = "00000000-0000-0000-0000-000000000001"


def upgrade() -> None:
    op.create_table(
        "spaces",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.execute(
        sa.text("INSERT INTO spaces (id, name) VALUES (CAST(:id AS uuid), 'Personal')").bindparams(
            id=DEFAULT_SPACE_ID
        )
    )
    op.add_column("items", sa.Column("space_id", sa.Uuid(as_uuid=True), nullable=True))
    op.execute(
        sa.text("UPDATE items SET space_id = CAST(:id AS uuid)").bindparams(id=DEFAULT_SPACE_ID)
    )
    op.alter_column("items", "space_id", nullable=False)
    op.create_index("ix_items_space_id", "items", ["space_id"])
    op.create_foreign_key(
        "fk_items_space_id_spaces",
        "items",
        "spaces",
        ["space_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.drop_constraint("items_content_hash_key", "items", type_="unique")
    op.create_unique_constraint(
        "uq_items_space_content_hash", "items", ["space_id", "content_hash"]
    )
    op.add_column("edges", sa.Column("label", sa.String(length=120), nullable=True))


def downgrade() -> None:
    op.drop_column("edges", "label")
    op.drop_constraint("uq_items_space_content_hash", "items", type_="unique")
    op.create_unique_constraint("items_content_hash_key", "items", ["content_hash"])
    op.drop_constraint("fk_items_space_id_spaces", "items", type_="foreignkey")
    op.drop_index("ix_items_space_id", table_name="items")
    op.drop_column("items", "space_id")
    op.drop_table("spaces")
