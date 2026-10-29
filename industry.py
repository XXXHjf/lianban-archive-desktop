"""Compatibility entrypoint for company profile operations."""
from lianban.profiles.industry import *

if __name__ == "__main__":
    with closing(initialize(DEFAULT_DB)):
        pass
    print(f"Updated {refresh()} current industry classifications.")
