import json

import pytest
from django.core.management import CommandError, call_command

from mcod.aed.models import AedDevice

GMINY = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"JPT_KOD_JE": "1465011", "JPT_NAZWA_": "Warszawa"},
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[20.8, 52.1], [21.3, 52.1], [21.3, 52.4], [20.8, 52.4], [20.8, 52.1]]],
            },
        }
    ],
}


def _records(*points):
    return {
        "records": [
            {"latitude": lat, "longitude": lon, "source": "test", "opening_hours": "24/7", "operator": f"AED {i}"}
            for i, (lat, lon) in enumerate(points)
        ]
    }


@pytest.fixture
def gminy_file(tmp_path):
    path = tmp_path / "gminy.json"
    path.write_text(json.dumps(GMINY), encoding="utf-8")
    return path


def _seed(tmp_path, gminy_file, payload, *extra):
    path = tmp_path / "scrape.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    call_command("seed_aed", "--input", str(path), "--gminy", str(gminy_file), *extra)


@pytest.mark.django_db
def test_seed_is_idempotent_and_prunes(tmp_path, gminy_file):
    _seed(tmp_path, gminy_file, _records((52.2297, 21.0122), (50.0614, 19.9366)))
    assert AedDevice.objects.count() == 2
    warsaw = AedDevice.objects.get(teryt_gmina="1465011")
    assert warsaw.gmina_name == "Warszawa"
    assert AedDevice.objects.filter(teryt_gmina=None).count() == 1

    _seed(tmp_path, gminy_file, _records((52.2297, 21.0122), (50.0614, 19.9366)))
    assert AedDevice.objects.count() == 2

    _seed(tmp_path, gminy_file, _records((52.2297, 21.0122)))
    assert list(AedDevice.objects.values_list("id", flat=True)) == [warsaw.id]


@pytest.mark.django_db
def test_seed_keep_stale_and_dry_run(tmp_path, gminy_file):
    _seed(tmp_path, gminy_file, _records((52.2297, 21.0122), (50.0614, 19.9366)))
    _seed(tmp_path, gminy_file, _records((52.2297, 21.0122)), "--keep-stale")
    assert AedDevice.objects.count() == 2

    _seed(tmp_path, gminy_file, _records((52.3, 21.1)), "--dry-run")
    assert AedDevice.objects.count() == 2


@pytest.mark.django_db
def test_seed_refuses_empty_input(tmp_path, gminy_file):
    _seed(tmp_path, gminy_file, _records((52.2297, 21.0122)))
    with pytest.raises(CommandError):
        _seed(tmp_path, gminy_file, {"records": [{"latitude": 10, "longitude": 10}]})
    assert AedDevice.objects.count() == 1
