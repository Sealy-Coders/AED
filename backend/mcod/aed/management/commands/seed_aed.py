import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from mcod.aed.etl import assign_gminy, deduplicate, load_records, validate
from mcod.aed.geo import GminaLocator
from mcod.aed.models import AedDevice
from mcod.aed.scraper import fetch_all_poland_aed

BATCH_SIZE = 1000
UPDATE_FIELDS = (
    "latitude",
    "longitude",
    "city",
    "address",
    "location_description",
    "opening_hours",
    "locked",
    "operator",
    "source",
    "source_id",
    "teryt_gmina",
    "gmina_name",
)


class Command(BaseCommand):
    help = (
        "Scrapes AED locations (dane.gov.pl + OpenAEDMap), validates, de-duplicates, "
        "assigns the gmina TERYT code and upserts them into the aed_device table. Idempotent."
    )

    def add_arguments(self, parser):
        parser.add_argument("--input", type=Path, help="Scraper result JSON to load instead of scraping live")
        parser.add_argument(
            "--output",
            type=Path,
            default=Path(settings.AED_SCRAPE_OUTPUT_PATH),
            help="Where to save the raw scraper result (live scrape only)",
        )
        parser.add_argument(
            "--gminy",
            type=Path,
            default=Path(settings.AED_GMINY_GEOJSON_PATH),
            help="Gminy GeoJSON (JPT_KOD_JE) used for the TERYT lookup",
        )
        parser.add_argument("--keep-stale", action="store_true", help="Keep rows missing from this scrape")
        parser.add_argument("--dry-run", action="store_true", help="Validate/transform only, write nothing")

    def handle(self, *args, **options):
        raw = self._load_from_file(options["input"]) if options["input"] else self._scrape(options["output"])
        self.stdout.write(f"Loaded {len(raw)} raw records")

        valid, rejected = validate(raw)
        self.stdout.write(f"Valid: {len(valid)}, rejected: {rejected or 0}")

        unique = deduplicate(valid)
        self.stdout.write(f"After de-duplication: {len(unique)} (merged {len(valid) - len(unique)})")
        if not unique:
            raise CommandError("No records to save - aborting so the table is not wiped.")

        if not options["gminy"].exists():
            raise CommandError(f"Gminy GeoJSON not found: {options['gminy']}")
        locator = GminaLocator.from_file(options["gminy"])
        self.stdout.write(f"Loaded {len(locator)} gminy from {options['gminy']}")
        records = assign_gminy(unique, locator)
        unassigned = sum(1 for rec in records if not rec["teryt_gmina"])
        self.stdout.write(f"Records without a gmina: {unassigned}")

        if options["dry_run"]:
            self.stdout.write(self.style.WARNING(f"--dry-run: nothing written. Example: {records[0]}"))
            return

        created, updated, deleted = self._save(records, prune=not options["keep_stale"])
        total = AedDevice.objects.count()
        self.stdout.write(
            self.style.SUCCESS(
                f"aed_device: created={created}, updated={updated}, deleted(stale)={deleted}, "
                f"total={total}, with gmina={AedDevice.objects.exclude(teryt_gmina=None).count()}"
            )
        )

    def _load_from_file(self, path: Path):
        try:
            return load_records(path)
        except (OSError, ValueError) as exc:
            raise CommandError(str(exc))

    def _scrape(self, output: Path):
        self.stdout.write("Running the AED scraper (dane.gov.pl + OpenAEDMap)…")
        result = asyncio.run(fetch_all_poland_aed())
        output.parent.mkdir(parents=True, exist_ok=True)
        payload = {"scraped_at": datetime.now(timezone.utc).isoformat(), **result}
        output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        self.stdout.write(f"Scraper stats: {result.get('stats')}; raw result saved to {output}")
        return list(result.get("records") or [])

    @transaction.atomic
    def _save(self, records, prune: bool):
        existing_ids = set(AedDevice.objects.values_list("id", flat=True))
        to_create, to_update = [], []
        for rec in records:
            device = AedDevice(**{field: rec.get(field) for field in ("id", *UPDATE_FIELDS)})
            (to_update if device.id in existing_ids else to_create).append(device)

        AedDevice.objects.bulk_create(to_create, batch_size=BATCH_SIZE)
        # bulk_update skips auto_now, so `modified` is set explicitly
        now = datetime.now(timezone.utc)
        for device in to_update:
            device.modified = now
        AedDevice.objects.bulk_update(to_update, [*UPDATE_FIELDS, "modified"], batch_size=BATCH_SIZE)

        deleted = 0
        if prune:
            deleted, _ = AedDevice.objects.exclude(id__in=[rec["id"] for rec in records]).delete()
        return len(to_create), len(to_update), deleted
