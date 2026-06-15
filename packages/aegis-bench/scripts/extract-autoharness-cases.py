"""AST extractor: pull (input -> expected RiskLevel) cases out of AutoHarness's
own tests/test_risk.py so a TS conformance harness can replay them against the
ported Aegis engine. Cases come from THEIR source, not hand-authored.

Emits JSON to stdout: a list of {id, kind, tool_name, tool_input, content,
expected_levels, custom_rules, expect_error}.
"""
from __future__ import annotations

import ast
import json
import sys


def literal(node):
    return ast.literal_eval(node)


def local_literals(fn):
    """Map simple `name = <literal>` assignments in a function body to their value.

    Handles implicit string concatenation across parenthesized lines (which the parser
    already folds into a single Constant) and plain literal RHS. Used to resolve a
    `classify_content(jwt)` arg where `jwt` is a local string built just above the call.
    """
    env = {}
    for n in ast.walk(fn):
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            try:
                env[n.targets[0].id] = ast.literal_eval(n.value)
            except Exception:
                pass
    return env


def resolve(node, env):
    """literal_eval a node, falling back to a resolved local Name binding."""
    if isinstance(node, ast.Name) and node.id in env:
        return env[node.id]
    return ast.literal_eval(node)


def find_call(node, func_names):
    """Find the first ast.Call whose func name is in func_names within node."""
    for n in ast.walk(node):
        if isinstance(n, ast.Call):
            fn = n.func
            name = None
            if isinstance(fn, ast.Name):
                name = fn.id
            elif isinstance(fn, ast.Attribute):
                name = fn.attr
            if name in func_names:
                yield n


def kw(call, key):
    for k in call.keywords:
        if k.arg == key:
            return k.value
    return None


def risklevel_names(node):
    """Extract RiskLevel.<x> names referenced in an assert comparison."""
    names = []
    for n in ast.walk(node):
        if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "RiskLevel":
            names.append(n.attr)
    return names


def main(path):
    src = open(path).read()
    tree = ast.parse(src)
    cases = []

    for cls in ast.walk(tree):
        if not isinstance(cls, ast.ClassDef):
            continue
        for fn in cls.body:
            if not isinstance(fn, ast.FunctionDef) or not fn.name.startswith("test_"):
                continue
            case = {
                "id": f"{cls.name}::{fn.name}",
                "kind": None,
                "tool_name": None,
                "tool_input": None,
                "content": None,
                "expected_levels": [],
                "custom_rules": None,
                "add_rule": None,
                "expect_error": None,
            }

            # detect pytest.raises (validation tests)
            for n in ast.walk(fn):
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "raises":
                    case["expect_error"] = True

            # constructor custom_rules
            for c in find_call(fn, {"RiskClassifier"}):
                cr = kw(c, "custom_rules")
                if cr is not None:
                    try:
                        case["custom_rules"] = literal(cr)
                    except Exception:
                        pass

            # add_custom_rule calls
            for c in find_call(fn, {"add_custom_rule"}):
                try:
                    rule = {}
                    for k in c.keywords:
                        rule[k.arg] = literal(k.value)
                    case["add_rule"] = rule
                except Exception:
                    pass

            env = local_literals(fn)

            # classify_content(...)
            cc = list(find_call(fn, {"classify_content"}))
            if cc:
                case["kind"] = "content"
                try:
                    case["content"] = resolve(cc[0].args[0], env)
                except Exception:
                    case["content"] = None

            # ToolCall(...)
            tcs = list(find_call(fn, {"ToolCall"}))
            if tcs and case["kind"] is None:
                case["kind"] = "toolcall"
                tc = tcs[0]
                tn = kw(tc, "tool_name")
                ti = kw(tc, "tool_input")
                try:
                    case["tool_name"] = literal(tn) if tn is not None else None
                except Exception:
                    case["tool_name"] = None
                try:
                    case["tool_input"] = literal(ti) if ti is not None else None
                except Exception:
                    case["tool_input"] = None

            # expected levels from asserts
            for n in ast.walk(fn):
                if isinstance(n, ast.Assert):
                    lv = risklevel_names(n)
                    if lv:
                        case["expected_levels"].extend(lv)

            # dedupe
            case["expected_levels"] = sorted(set(case["expected_levels"]))

            # only keep cases that exercise classification
            if case["kind"] or case["expect_error"]:
                cases.append(case)

    json.dump(cases, sys.stdout, indent=2)


if __name__ == "__main__":
    main(sys.argv[1])
