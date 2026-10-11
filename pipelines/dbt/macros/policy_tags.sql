{#- Full policy tag resource name for a data class (BigQuery only). The map comes from var('pv_policy_tags'):
    real names from `pv dbt --target bigquery`, placeholders for bigquery_ci, ignored on DuckDB. -#}
{% macro pv_policy_tag(data_class) -%}
  {{ return(var('pv_policy_tags')[data_class]) }}
{%- endmacro %}
