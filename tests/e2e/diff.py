import json, sys
a = json.load(open(sys.argv[1])); b = json.load(open(sys.argv[2]))
def diff(x, y, path=""):
    if type(x) != type(y):
        return [f"{path}: {x!r} != {y!r}"]
    if isinstance(x, dict):
        return [d for k in sorted(set(x) | set(y)) for d in diff(x.get(k), y.get(k), f"{path}.{k}")]
    if isinstance(x, list):
        if len(x) != len(y):
            return [f"{path}: len {len(x)} != {len(y)}\n   A={json.dumps(x, ensure_ascii=False)}\n   B={json.dumps(y, ensure_ascii=False)}"]
        return [d for i, (p, q) in enumerate(zip(x, y)) for d in diff(p, q, f"{path}[{i}]")]
    return [] if x == y else [f"{path}: {x!r} != {y!r}"]
keys = ("final", "checkpoints", "toasts", "steps")
d = diff({k: a[k] for k in keys}, {k: b[k] for k in keys})
print("\n".join(d) if d else "IDENTICAL")
