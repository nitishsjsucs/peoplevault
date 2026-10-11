{#- Column masking in purpose views. BigQuery: the raw column is selected and the policy tag's data masking
    policy masks it for the querying purpose identity (ALWAYS_NULL, DATE_YEAR_MASK). DuckDB (local stand-in,
    no IAM): the same cell compiles to an expression in the view. -#}
{% macro pv_mask(column, visibility) -%}
  {%- if target.type == 'bigquery' or visibility == 'allow' -%}
    {{ column }}
  {%- elif visibility == 'mask_nullify' -%}
    (case when 1 = 0 then {{ column }} end)
  {%- elif visibility == 'mask_date_year' -%}
    cast(date_trunc('year', {{ column }}) as date)
  {%- else -%}
    {{ exceptions.raise_compiler_error("deny columns are never selected: " ~ column) }}
  {%- endif -%}
{%- endmacro %}

{#- Authorized view grants (BigQuery only): the purpose views may read these source datasets. -#}
{% macro pv_grant_access_to(datasets) -%}
  {%- if target.type == 'bigquery' -%}
    {%- set out = [] -%}
    {%- for d in datasets -%}{%- do out.append({'project': target.project, 'dataset': d}) -%}{%- endfor -%}
    {{ return(out) }}
  {%- else -%}
    {{ return([]) }}
  {%- endif -%}
{%- endmacro %}
