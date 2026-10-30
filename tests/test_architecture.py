"""Protect dependency directions instead of the textual layout of implementation files."""
import ast
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "lianban"
LEGACY_MODULES = {
    "app", "desktop", "database", "provider", "live_update", "live_pool", "sync_data",
    "industry", "registration", "concept_tags", "suspension", "intraday", "intraday_sources",
    "intraday_timeline", "relationships", "published_tags", "tag_management", "provinces",
    "realtime", "collect_intraday", "import_manual", "backup_db", "shareholders", "shareholder_seed",
}
PURE_MODULES = {
    "lianban.archive.cycles", "lianban.archive.relationships", "lianban.intraday.rules",
    "lianban.intraday.timeline_rules",
    "lianban.nodes.rules",
}
IMPURE_PREFIXES = (
    "sqlite3", "requests", "http", "urllib", "threading", "concurrent", "socket",
    "subprocess", "multiprocessing", "lianban.storage", "lianban.adapters", "lianban.runtime",
    "lianban.interfaces", "lianban.ingestion", "lianban.profiles", "lianban.readside",
    "lianban.research",
)


def module_name(path):
    parts = list(path.relative_to(ROOT).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def imports(tree, module, is_package, known_modules):
    """Resolve relative imports and module aliases, including function-local imports.

    For `from . import item`, item may be a module or an exported symbol. Only
    real modules become graph edges; the containing package still supplies symbols.
    """
    package = module if is_package else module.rpartition(".")[0]
    result = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            result.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                parts = package.split(".")
                if node.level > len(parts):
                    raise ValueError(f"Import escapes package in {module}")
                base = ".".join(parts[:len(parts) - node.level + 1])
                if node.module:
                    base += "." + node.module
            else:
                base = node.module or ""
            if base:
                result.add(base)
            for alias in node.names:
                candidate = base + "." + alias.name if base else alias.name
                if candidate in known_modules:
                    result.add(candidate)
    return result


def dependency_graph():
    files = {module_name(path): path for path in PACKAGE.rglob("*.py")}
    all_imports = {
        name: imports(ast.parse(path.read_text(encoding="utf-8-sig")), name,
                      path.name == "__init__.py", files)
        for name, path in files.items()
    }
    return all_imports, {name: values & files.keys() for name, values in all_imports.items()}


def cycles(graph):
    """Return back-edge paths so a failure identifies the dependency to remove."""
    visited, active, stack, found = set(), set(), [], []
    def visit(node):
        if node in active:
            found.append(stack[stack.index(node):] + [node])
            return
        if node in visited:
            return
        active.add(node)
        stack.append(node)
        for child in sorted(graph[node]):
            visit(child)
        stack.pop()
        active.remove(node)
        visited.add(node)
    for node in sorted(graph):
        visit(node)
    return found


def matches_prefix(name, prefixes):
    return any(name == prefix or name.startswith(prefix + ".") for prefix in prefixes)


class ArchitectureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.all_imports, cls.graph = dependency_graph()

    def test_application_package_does_not_import_compatibility_entrypoints(self):
        violations = [(module, target) for module, targets in self.all_imports.items()
                      for target in targets if target.split(".")[0] in LEGACY_MODULES]
        self.assertEqual(violations, [], f"Package imports legacy entrypoints: {violations}")

    def test_pure_rules_have_no_transitive_storage_transport_or_worker_dependencies(self):
        pure = PURE_MODULES | {name for name in self.graph if name == "lianban.core" or name.startswith("lianban.core.")}
        violations = []
        for origin in sorted(pure):
            pending, seen = [origin], set()
            while pending:
                current = pending.pop()
                if current in seen:
                    continue
                seen.add(current)
                violations.extend((origin, current, target) for target in self.all_imports[current]
                                  if matches_prefix(target, IMPURE_PREFIXES))
                pending.extend(self.graph[current] - seen)
        self.assertEqual(violations, [], f"Pure rules depend on infrastructure: {violations}")

    def test_static_application_import_graph_is_acyclic(self):
        found = cycles(self.graph)
        self.assertEqual(found, [], "Import cycles: " + "; ".join(" -> ".join(path) for path in found))

    def test_relative_import_resolution_tracks_modules_without_inventing_symbol_modules(self):
        known = {"sample", "sample.area", "sample.area.service", "sample.rules", "sample.area.worker"}
        source = ast.parse("from ..rules import parse\nfrom . import worker\nfrom .service import run\n")
        self.assertEqual(imports(source, "sample.area.entry", False, known),
                         {"sample.rules", "sample.area", "sample.area.worker", "sample.area.service"})
        self.assertEqual(imports(ast.parse("from .service import run"), "sample.area", True, known),
                         {"sample.area.service"})
        self.assertEqual(cycles({"a": {"b"}, "b": {"a"}}), [["a", "b", "a"]])


if __name__ == "__main__":
    unittest.main()
