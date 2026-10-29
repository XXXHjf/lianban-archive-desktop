"""Compatibility entrypoint for company profile operations."""
from lianban.profiles.registration import *

if __name__ == "__main__":
    with closing(initialize(DEFAULT_DB)):
        pass
    print(f"Updated {refresh()} company registration provinces.")
