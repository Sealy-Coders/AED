from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="AedDevice",
            fields=[
                ("id", models.CharField(max_length=32, primary_key=True, serialize=False, verbose_name="id")),
                ("latitude", models.FloatField(verbose_name="latitude")),
                ("longitude", models.FloatField(verbose_name="longitude")),
                ("city", models.CharField(blank=True, max_length=255, null=True, verbose_name="city")),
                ("address", models.TextField(blank=True, null=True, verbose_name="address")),
                (
                    "location_description",
                    models.TextField(blank=True, null=True, verbose_name="location description"),
                ),
                (
                    "opening_hours",
                    models.CharField(blank=True, max_length=512, null=True, verbose_name="opening hours"),
                ),
                ("locked", models.BooleanField(default=False, verbose_name="locked")),
                ("operator", models.TextField(blank=True, null=True, verbose_name="operator")),
                ("source", models.TextField(verbose_name="source")),
                ("source_id", models.CharField(blank=True, max_length=255, null=True, verbose_name="source id")),
                (
                    "teryt_gmina",
                    models.CharField(blank=True, db_index=True, max_length=7, null=True, verbose_name="TERYT code"),
                ),
                ("gmina_name", models.CharField(blank=True, max_length=255, null=True, verbose_name="commune")),
                ("created", models.DateTimeField(auto_now_add=True, verbose_name="created")),
                ("modified", models.DateTimeField(auto_now=True, verbose_name="modified")),
            ],
            options={
                "verbose_name": "AED defibrillator",
                "verbose_name_plural": "AED defibrillators",
                "db_table": "aed_device",
            },
        ),
        migrations.AddIndex(
            model_name="aeddevice",
            index=models.Index(fields=["latitude", "longitude"], name="aed_device_lat_lon"),
        ),
    ]
