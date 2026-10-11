from click.testing import CliRunner

from peoplevault import config
from peoplevault.cli import main


def test_pv_help_lists_commands():
    result = CliRunner().invoke(main, ["--help"])
    assert result.exit_code == 0
    assert "PeopleVault pipelines" in result.output


def test_repo_root_is_found():
    assert (config.REPO_ROOT / "wrangler.jsonc").exists()
    assert config.DBT_DIR.joinpath("dbt_project.yml").exists()


def test_jsonc_reader_handles_comments_and_trailing_commas():
    text = '{\n  // c\n  "a": "x//y", /* b */ "b": [1,2,],\n}'
    assert config.read_jsonc_text(text) == {"a": "x//y", "b": [1, 2]}


def test_wrangler_vars_readable():
    cfg = config.read_jsonc(config.WRANGLER_JSONC)
    assert cfg["name"] == "peoplevault-local"
    assert cfg["vars"]["DEV_ACCESS_AUD"] == "peoplevault-local"


def test_env_file_parser(tmp_path):
    p = tmp_path / "x.env"
    p.write_text('# c\nA=1\nB="two=2"\n\nC=\n')
    assert config.parse_env_file(p) == {"A": "1", "B": "two=2", "C": ""}
