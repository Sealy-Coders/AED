import falcon
import pytest

from mcod.aed.models import AedDevice

pytestmark = [
    pytest.mark.depends_on_component,
    pytest.mark.component_api,
]


@pytest.fixture
def aed_devices(db):
    return [
        AedDevice.objects.create(
            id="aed-warsaw",
            latitude=52.2297,
            longitude=21.0122,
            city="Warszawa",
            address="ul. Marszałkowska 1",
            opening_hours="24/7",
            operator="Metro Warszawskie",
            source="OpenAEDMap / OpenStreetMap",
            teryt_gmina="1465011",
            gmina_name="Warszawa",
        ),
        AedDevice.objects.create(
            id="aed-krakow",
            latitude=50.0614,
            longitude=19.9366,
            opening_hours="nieznane",
            source="dane.gov.pl (test)",
            teryt_gmina="1261011",
            gmina_name="Kraków",
        ),
        AedDevice.objects.create(id="aed-nowhere", latitude=54.5, longitude=14.2, source="test"),
    ]


def test_frequencies(client14, aed_devices):
    resp = client14.simulate_get("/1.4/aed/frequencies")
    assert resp.status == falcon.HTTP_200
    assert resp.json == {
        "voivodeships": {"14": 1, "12": 1},
        "counties": {"1465": 1, "1261": 1},
        "communes": {"1465011": 1, "1261011": 1},
        "total": 3,
        "unassigned": 1,
    }


def test_list_with_bbox_and_status(client14, aed_devices):
    resp = client14.simulate_get("/1.4/aed", params={"bbox": "20.9,52.1,21.1,52.3"})
    assert resp.status == falcon.HTTP_200
    assert resp.json["count"] == 1
    item = resp.json["items"][0]
    assert item["id"] == "aed-warsaw"
    assert item["name"] == "Metro Warszawskie"
    assert item["address"] == "ul. Marszałkowska 1, Warszawa"
    assert item["is_24_7"] is True
    assert item["status"]["key"] == "open_24_7"


def test_list_only_open_now(client14, aed_devices):
    resp = client14.simulate_get("/1.4/aed", params={"only_open_now": "true"})
    assert [item["id"] for item in resp.json["items"]] == ["aed-warsaw"]


def test_list_invalid_bbox(client14, aed_devices):
    assert client14.simulate_get("/1.4/aed", params={"bbox": "1,2,3"}).status == falcon.HTTP_400
    assert client14.simulate_get("/1.4/aed", params={"bbox": "a,b,c,d"}).status == falcon.HTTP_400


def test_detail(client14, aed_devices):
    resp = client14.simulate_get("/1.4/aed/aed-krakow")
    assert resp.status == falcon.HTTP_200
    assert resp.json["opening_hours_raw"] is None
    assert resp.json["status"]["key"] == "unknown"
    assert resp.json["name"] == "Defibrylator AED"

    assert client14.simulate_get("/1.4/aed/does-not-exist").status == falcon.HTTP_404
