from mnemosyne.config import Settings


def test_supabase_style_database_url_uses_async_driver_and_ssl() -> None:
    settings = Settings(
        database_url="postgresql://user:password@db.example.test:5432/notes?sslmode=require"
    )

    assert settings.database_url.startswith("postgresql+asyncpg://")
    assert "ssl=require" in settings.database_url
    assert "sslmode" not in settings.database_url
