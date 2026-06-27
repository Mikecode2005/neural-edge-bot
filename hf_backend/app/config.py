import os
from functools import lru_cache
from dotenv import load_dotenv

load_dotenv()


class Settings:
    HF_TOKEN: str = os.getenv("HF_TOKEN", "")
    QWEN_MODEL: str = os.getenv("QWEN_MODEL", "Qwen/Qwen2.5-7B-Instruct")

    SUPABASE_URL: str = os.getenv("SUPABASE_URL", "")
    SUPABASE_SERVICE_ROLE_KEY: str = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

    DERIV_APP_ID: str = os.getenv("DERIV_APP_ID", "1089")
    DERIV_API_TOKEN: str = os.getenv("DERIV_API_TOKEN", "")
    DERIV_WS_URL: str = "wss://ws.derivws.com/websockets/v3"

    ENCRYPTION_KEY: str = os.getenv("ENCRYPTION_KEY", "")
    CORS_ORIGINS: list[str] = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",")]

    DEMO_STARTING_BALANCE: float = 10_000.0
    MAX_DAILY_LOSS_DEFAULT: float = 500.0
    MAX_OPEN_TRADES_DEFAULT: int = 5


@lru_cache
def get_settings() -> Settings:
    return Settings()
