"""Replace direct Effect tag predicates with Predicate.isTagged; safe to rerun."""
from pathlib import Path
import re

comparison = re.compile(r'\b([A-Za-z_$][\w$]*)\._tag\s*(===|!==)\s*("[^"]+")')
imports = re.compile(r'import\s*\{([^}]+)\}\s*from "effect";')
for root in ('apps', 'packages', 'scripts', 'tests'):
    for path in Path(root).rglob('*.ts'):
        source = path.read_text()
        updated = comparison.sub(lambda m: ('!' if m[2] == '!==' else '') + f'Predicate.isTagged({m[1]}, {m[3]})', source)
        if updated == source:
            continue
        match = imports.search(updated)
        if match is None:
            raise ValueError(f'No Effect import in {path}')
        names = match[1]
        if not re.search(r'\bPredicate\b', names):
            updated = updated[:match.start(1)] + ' Predicate, ' + names.strip() + ' ' + updated[match.end(1):]
        path.write_text(updated)
