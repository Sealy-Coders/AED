from django.db import models
from django.utils.translation import gettext_lazy as _


class AedDevice(models.Model):
    """
    A single defibrillator location.

    The primary key is deterministic (derived from rounded coordinates, see
    ``mcod.aed.etl.record_id``), so re-running ``seed_aed`` updates rows in place.
    """

    id = models.CharField(primary_key=True, max_length=32, verbose_name=_("id"))
    latitude = models.FloatField(verbose_name=_("latitude"))
    longitude = models.FloatField(verbose_name=_("longitude"))
    city = models.CharField(max_length=255, null=True, blank=True, verbose_name=_("city"))
    address = models.TextField(null=True, blank=True, verbose_name=_("address"))
    location_description = models.TextField(null=True, blank=True, verbose_name=_("location description"))
    # Raw OSM-style `opening_hours` string, parsed on read by mcod.aed.opening_hours
    opening_hours = models.CharField(max_length=512, null=True, blank=True, verbose_name=_("opening hours"))
    locked = models.BooleanField(default=False, verbose_name=_("locked"))
    operator = models.TextField(null=True, blank=True, verbose_name=_("operator"))
    source = models.TextField(verbose_name=_("source"))
    source_id = models.CharField(max_length=255, null=True, blank=True, verbose_name=_("source id"))
    teryt_gmina = models.CharField(max_length=7, null=True, blank=True, db_index=True, verbose_name=_("TERYT code"))
    gmina_name = models.CharField(max_length=255, null=True, blank=True, verbose_name=_("commune"))
    created = models.DateTimeField(auto_now_add=True, verbose_name=_("created"))
    modified = models.DateTimeField(auto_now=True, verbose_name=_("modified"))

    class Meta:
        db_table = "aed_device"
        verbose_name = _("AED defibrillator")
        verbose_name_plural = _("AED defibrillators")
        indexes = [models.Index(fields=["latitude", "longitude"], name="aed_device_lat_lon")]

    def __str__(self):
        return f"{self.id} ({self.latitude:.5f}, {self.longitude:.5f})"
