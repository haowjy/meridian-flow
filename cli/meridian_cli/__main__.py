#!/usr/bin/env python3
"""Entry point for running meridian_cli as a module (python -m meridian_cli)"""

import os
import logging
from .app import MeridianCLI
from .logger import setup_logging


def main():
    """Entry point for the CLI"""
    # Initialize logging
    setup_logging()
    logger = logging.getLogger("meridian_cli")

    # Get base URL from environment or use default
    base_url = os.getenv("MERIDIAN_BASE_URL", "http://localhost:8080")
    logger.info(f"Starting Meridian CLI with base_url={base_url}")

    app = MeridianCLI(base_url)
    app.run()


if __name__ == "__main__":
    main()
