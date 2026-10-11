{#- Generic data tests. dbt never runs with store_failures here, so failing rows are counted, not stored. -#}

{% test no_direct_identifiers(model) %}
  {%- set banned = pv_direct_identifier_columns() -%}
  {%- set found = [] -%}
  {%- if execute -%}
    {%- for c in adapter.get_columns_in_relation(model) -%}
      {%- if c.name | lower in banned -%}{%- do found.append(c.name | lower) -%}{%- endif -%}
    {%- endfor -%}
  {%- endif -%}
  select '{{ found | join(",") }}' as direct_identifier_columns
  {% if found | length == 0 %}where 1 = 0{% endif %}
{% endtest %}

{% test k_anonymity(model, column_name, min_k=5) %}
  select {{ column_name }} from {{ model }} where {{ column_name }} < {{ min_k }}
{% endtest %}

{% test no_suppressed_subjects(model) %}
  select m.subject_ref
  from {{ model }} m
  join {{ source('pv_restricted', 'suppression') }} s on s.subject_ref = m.subject_ref
{% endtest %}

{% test pv_unique_combination(model, columns) %}
  select {{ columns | join(', ') }}, count(*) as n
  from {{ model }}
  group by {{ columns | join(', ') }}
  having count(*) > 1
{% endtest %}
