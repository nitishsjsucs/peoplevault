{#- Custom schema names are used verbatim (pv_core, pv_marts, ...) on both DuckDB and BigQuery, so the
    datasets keep the names in policy/policy.yaml instead of dbt's default <target>_<custom> prefixing. -#}
{% macro generate_schema_name(custom_schema_name, node) -%}
  {%- if custom_schema_name is none -%}{{ target.schema }}{%- else -%}{{ custom_schema_name | trim }}{%- endif -%}
{%- endmacro %}
