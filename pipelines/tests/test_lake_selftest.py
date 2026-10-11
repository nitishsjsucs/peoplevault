from peoplevault.lake.catalog import open_catalog
from peoplevault.lake.selftest import TABLE, run_selftest


def test_selftest_passes_on_the_local_catalog_and_cleans_up(tmp_path):
    cat = open_catalog("local", root=tmp_path)
    assert run_selftest(cat)["selftest"] == "ok"
    assert not cat.table_exists(TABLE)
