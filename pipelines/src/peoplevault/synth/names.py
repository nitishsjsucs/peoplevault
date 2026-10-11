"""Synthetic first and last names.

Constraints (checked by test_token_collisions.py): no first name is a proper suffix of another first name and
no last name is a proper prefix of another last name (case-insensitive). That rules out collisions such as
`ian.chen@` inside `brian.chen@`, "Ann Li" inside "Ann Lin" and "Ann Ng" inside "Ann Nguyen", so a
boundary-aware probe for one employee's name or email can never match another employee's values.
"""

FIRST_NAMES: tuple[str, ...] = (
    "Aaron", "Ada", "Aditi", "Akira", "Alejandro", "Amara", "Anders", "Beatriz", "Bruno", "Caleb",
    "Camila", "Chidi", "Dalia", "Dmitri", "Elena", "Emeka", "Farah", "Felix", "Gabriel", "Grace",
    "Hana", "Hugo", "Imani", "Ingrid", "Isaac", "Jamal", "Javier", "Keiko", "Kofi", "Lars",
    "Leila", "Lucas", "Maya", "Mateo", "Nadia", "Naveen", "Olga", "Omar", "Priya", "Quentin",
    "Rafael", "Rania", "Ravi", "Rosa", "Samir", "Sofia", "Tariq", "Teresa", "Tomas", "Uma",
    "Valeria", "Victor", "Wei", "Xavier", "Yara", "Yusuf", "Zainab", "Zoe", "Kenji", "Ines",
)

LAST_NAMES: tuple[str, ...] = (
    "Abbott", "Banerjee", "Castillo", "Dubois", "Eriksen", "Fujita", "Garcia", "Haddad", "Iwu", "Jensen",
    "Kowalski", "Lindqvist", "Moreau", "Nakamura", "Okafor", "Petrov", "Quintero", "Rahman", "Santos", "Takahashi",
    "Ueda", "Varga", "Whitfield", "Xu", "Yilmaz", "Zhou", "Ahmadi", "Bianchi", "Costa", "Delgado",
    "Esposito", "Fischer", "Gomez", "Horvat", "Ivanova", "Joshi", "Kim", "Mensah", "Novak", "Ortiz",
)


def suffix_free(names: tuple[str, ...]) -> bool:
    low = [n.lower() for n in names]
    return not any(a != b and b.endswith(a) for a in low for b in low)


def prefix_free(names: tuple[str, ...]) -> bool:
    low = [n.lower() for n in names]
    return not any(a != b and b.startswith(a) for a in low for b in low)


assert len(FIRST_NAMES) == 60 and len(set(FIRST_NAMES)) == 60
assert len(LAST_NAMES) == 40 and len(set(LAST_NAMES)) == 40
assert suffix_free(FIRST_NAMES), "first names must be suffix-free"
assert prefix_free(LAST_NAMES), "last names must be prefix-free"
