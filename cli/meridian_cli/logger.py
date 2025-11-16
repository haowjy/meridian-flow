"""Logging configuration for Meridian CLI"""

import logging
import os
from datetime import datetime
from pathlib import Path


def setup_logging() -> logging.Logger:
    """Initialize logging for the Meridian CLI

    Creates a timestamped log file in meridian_cli/logs/ and configures
    logging to write detailed DEBUG-level logs.

    Returns:
        Logger instance configured for the application
    """
    # Determine log directory
    cli_dir = Path(__file__).parent
    log_dir = cli_dir / "logs"
    log_dir.mkdir(exist_ok=True)

    # Generate timestamped log filename
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    log_file = log_dir / f"meridian_{timestamp}.log"

    # Configure logging format
    log_format = "[%(asctime)s] %(levelname)s - %(name)s.%(funcName)s:%(lineno)d - %(message)s"
    date_format = "%Y-%m-%d %H:%M:%S"

    # Create file handler
    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(logging.Formatter(log_format, date_format))

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.DEBUG)
    root_logger.addHandler(file_handler)

    # Create logger for this package
    logger = logging.getLogger("meridian_cli")
    logger.setLevel(logging.DEBUG)

    # Log startup
    logger.info(f"Logging initialized - writing to {log_file}")

    # Cleanup old logs
    cleanup_old_logs(log_dir, keep_count=10)

    return logger


def cleanup_old_logs(log_dir: Path, keep_count: int = 10) -> None:
    """Remove old log files, keeping only the most recent ones

    Args:
        log_dir: Directory containing log files
        keep_count: Number of recent log files to keep (default: 10)
    """
    try:
        # Find all log files
        log_files = sorted(
            log_dir.glob("meridian_*.log"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,  # Most recent first
        )

        # Delete old files
        for old_file in log_files[keep_count:]:
            try:
                old_file.unlink()
                logging.getLogger("meridian_cli").debug(f"Deleted old log file: {old_file.name}")
            except Exception as e:
                logging.getLogger("meridian_cli").warning(f"Failed to delete old log {old_file.name}: {e}")

    except Exception as e:
        logging.getLogger("meridian_cli").warning(f"Failed to cleanup old logs: {e}")
