"""
Scan metadata JSON files, convert referenced JPEG/JPG images to PNG, and optionally
update metadata image references.
"""

from __future__ import annotations

import argparse
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit, urlunsplit

from PIL import Image, UnidentifiedImageError

# Default run modes (can be overridden via CLI flags).
DRY_RUN = False
UPDATE_METADATA = False
OVERWRITE = False

JPEG_EXTENSIONS = {".jpeg", ".jpg"}
LOGGER = logging.getLogger("jpeg_to_png")


@dataclass
class SummaryStats:
    total_metadata_scanned: int = 0
    jpeg_found: int = 0
    png_created: int = 0
    already_existing_png: int = 0
    errors: int = 0
    metadata_updated: int = 0


def configure_logging(level: str) -> None:
    """Configure root logging."""
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s | %(levelname)s | %(message)s",
    )


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments."""
    parser = argparse.ArgumentParser(
        description="Convert JPEG/JPG files referenced by metadata JSON files to PNG."
    )
    parser.add_argument(
        "--metadata-dir",
        type=Path,
        default=Path("metadata"),
        help="Directory containing metadata JSON files (default: ./metadata).",
    )
    parser.add_argument(
        "--art-dir",
        type=Path,
        default=Path("art"),
        help="Directory containing image files (default: ./art).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=DRY_RUN,
        help="Run without writing files.",
    )
    parser.add_argument(
        "--update-metadata",
        action="store_true",
        default=UPDATE_METADATA,
        help="Update metadata 'image' field to .png reference.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        default=OVERWRITE,
        help="Overwrite existing PNG files.",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        help="Logging level (DEBUG, INFO, WARNING, ERROR).",
    )
    return parser.parse_args()


def extract_image_filename(image_ref: str) -> Optional[str]:
    """Extract the filename portion from an image reference string."""
    if not isinstance(image_ref, str):
        return None

    value = image_ref.strip()
    if not value:
        return None

    parsed = urlsplit(value)
    path_part = parsed.path or value.split("?", 1)[0].split("#", 1)[0]
    filename = Path(path_part).name
    return filename or None


def is_jpeg_filename(filename: str) -> bool:
    """Return True if filename has .jpeg or .jpg extension."""
    return Path(filename).suffix.lower() in JPEG_EXTENSIONS


def replace_basename_in_path(path_text: str, new_filename: str) -> str:
    """Replace trailing basename in path while preserving separator style."""
    if "/" in path_text:
        prefix = path_text.rsplit("/", 1)[0]
        if prefix:
            return f"{prefix}/{new_filename}"
        return f"/{new_filename}" if path_text.startswith("/") else new_filename

    if "\\" in path_text:
        prefix = path_text.rsplit("\\", 1)[0]
        return f"{prefix}\\{new_filename}" if prefix else new_filename

    return new_filename


def replace_image_reference(image_ref: str, new_filename: str) -> str:
    """Replace the image reference filename with a new filename."""
    parsed = urlsplit(image_ref)
    if parsed.path:
        new_path = replace_basename_in_path(parsed.path, new_filename)
        return urlunsplit((parsed.scheme, parsed.netloc, new_path, parsed.query, parsed.fragment))
    return new_filename


def load_json_file(path: Path) -> Optional[dict[str, Any]]:
    """Load a JSON file and return a dict object, or None on failure."""
    try:
        with path.open("r", encoding="utf-8") as file:
            data = json.load(file)
    except json.JSONDecodeError as exc:
        LOGGER.error("JSON parse error in %s: %s", path, exc)
        return None
    except OSError as exc:
        LOGGER.error("Failed to read %s: %s", path, exc)
        return None

    if not isinstance(data, dict):
        LOGGER.error("JSON root is not an object in %s", path)
        return None

    return data


def save_json_file(path: Path, data: dict[str, Any], dry_run: bool) -> bool:
    """Save JSON data to file unless dry-run is enabled."""
    if dry_run:
        LOGGER.info("DRY_RUN: would update metadata file %s", path)
        return True

    try:
        with path.open("w", encoding="utf-8") as file:
            json.dump(data, file, indent=2, ensure_ascii=False)
            file.write("\n")
        return True
    except OSError as exc:
        LOGGER.error("Failed to write %s: %s", path, exc)
        return False


def find_source_image(art_dir: Path, image_filename: str) -> Optional[Path]:
    """Find source JPEG/JPG in art directory by exact name, then by stem."""
    stem = Path(image_filename).stem
    candidates = [
        art_dir / image_filename,
        art_dir / f"{stem}.jpeg",
        art_dir / f"{stem}.jpg",
    ]

    seen: set[str] = set()
    unique_candidates: list[Path] = []
    for candidate in candidates:
        key = str(candidate).lower()
        if key not in seen:
            seen.add(key)
            unique_candidates.append(candidate)

    for candidate in unique_candidates:
        if candidate.is_file() and candidate.suffix.lower() in JPEG_EXTENSIONS:
            return candidate

    try:
        for candidate in sorted(art_dir.iterdir()):
            if (
                candidate.is_file()
                and candidate.stem.lower() == stem.lower()
                and candidate.suffix.lower() in JPEG_EXTENSIONS
            ):
                return candidate
    except OSError as exc:
        LOGGER.error("Failed to scan art directory %s: %s", art_dir, exc)

    return None


def convert_to_png(
    source_path: Path,
    target_path: Path,
    dry_run: bool,
    overwrite: bool,
) -> tuple[str, Optional[str]]:
    """
    Convert source JPEG/JPG to PNG.
    Returns (status, error_message):
      - status: 'created', 'exists', or 'error'
    """
    if target_path.exists() and not overwrite:
        return "exists", None

    if dry_run:
        return "created", None

    try:
        with Image.open(source_path) as img:
            img.load()  # Force decode to catch corrupted inputs early.
            img.save(target_path, format="PNG")
        return "created", None
    except (UnidentifiedImageError, OSError) as exc:
        return "error", str(exc)


def process_metadata_file(
    metadata_path: Path,
    art_dir: Path,
    dry_run: bool,
    update_metadata: bool,
    overwrite: bool,
    stats: SummaryStats,
) -> None:
    """Process one metadata JSON file end-to-end."""
    stats.total_metadata_scanned += 1
    metadata = load_json_file(metadata_path)
    if metadata is None:
        stats.errors += 1
        return

    image_ref = metadata.get("image")
    if not isinstance(image_ref, str):
        LOGGER.debug("No string 'image' field in %s", metadata_path)
        return

    image_filename = extract_image_filename(image_ref)
    if not image_filename or not is_jpeg_filename(image_filename):
        LOGGER.debug("Image in %s is not JPEG/JPG: %r", metadata_path, image_ref)
        return

    stats.jpeg_found += 1

    source_image = find_source_image(art_dir, image_filename)
    if source_image is None:
        LOGGER.error("Missing source image for %s (expected %s in %s)", metadata_path, image_filename, art_dir)
        stats.errors += 1
        return

    target_png = art_dir / f"{source_image.stem}.png"
    status, error_message = convert_to_png(source_image, target_png, dry_run, overwrite)

    if status == "exists":
        stats.already_existing_png += 1
        LOGGER.info("PNG already exists, skipping conversion: %s", target_png)
        conversion_available = True
    elif status == "created":
        stats.png_created += 1
        action = "would create" if dry_run else "created"
        LOGGER.info("PNG %s: %s -> %s", action, source_image, target_png)
        conversion_available = True
    else:
        LOGGER.error("Failed conversion %s -> %s: %s", source_image, target_png, error_message)
        stats.errors += 1
        conversion_available = False

    # Only update metadata when a usable PNG exists (or would exist in dry-run).
    if update_metadata and conversion_available:
        new_image_ref = replace_image_reference(image_ref, target_png.name)
        if new_image_ref != image_ref:
            metadata["image"] = new_image_ref
            if save_json_file(metadata_path, metadata, dry_run):
                stats.metadata_updated += 1
                LOGGER.info("Metadata image updated in %s: %r -> %r", metadata_path, image_ref, new_image_ref)
            else:
                stats.errors += 1


def print_summary(stats: SummaryStats) -> None:
    """Print a clear final summary report."""
    print("\n=== Conversion Summary ===")
    print(f"total metadata scanned: {stats.total_metadata_scanned}")
    print(f"jpeg found: {stats.jpeg_found}")
    print(f"png created: {stats.png_created}")
    print(f"already existing png: {stats.already_existing_png}")
    print(f"errors: {stats.errors}")
    print(f"metadata updated: {stats.metadata_updated}")


def main() -> int:
    """Program entry point."""
    args = parse_args()
    configure_logging(args.log_level)

    metadata_dir: Path = args.metadata_dir
    art_dir: Path = args.art_dir
    dry_run: bool = args.dry_run
    update_metadata: bool = args.update_metadata
    overwrite: bool = args.overwrite

    stats = SummaryStats()

    if not metadata_dir.is_dir():
        LOGGER.error("Metadata directory not found: %s", metadata_dir)
        stats.errors += 1
        print_summary(stats)
        return 1

    if not art_dir.is_dir():
        LOGGER.error("Art directory not found: %s", art_dir)
        stats.errors += 1
        print_summary(stats)
        return 1

    metadata_files = sorted(metadata_dir.glob("*.json"))
    if not metadata_files:
        LOGGER.warning("No metadata JSON files found in %s", metadata_dir)

    for metadata_path in metadata_files:
        process_metadata_file(
            metadata_path=metadata_path,
            art_dir=art_dir,
            dry_run=dry_run,
            update_metadata=update_metadata,
            overwrite=overwrite,
            stats=stats,
        )

    print_summary(stats)
    return 1 if stats.errors > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
