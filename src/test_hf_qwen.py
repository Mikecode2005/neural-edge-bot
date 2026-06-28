import os
from pathlib import Path

# Load the Hugging Face token from environment or .env
HF_TOKEN = os.getenv("HF_TOKEN")
if not HF_TOKEN:
    raise EnvironmentError("HF_TOKEN not set in environment variables")

def test_qwen_token_loaded():
    """Simple test to ensure the Hugging Face token is available."""
    assert isinstance(HF_TOKEN, str) and len(HF_TOKEN) > 0

if __name__ == "__main__":
    # Run a quick sanity check when executing directly
    try:
        test_qwen_token_loaded()
        print("HF token loaded successfully.")
    except AssertionError:
        print("HF token is missing or empty.")
