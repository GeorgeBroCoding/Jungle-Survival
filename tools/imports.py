"""Rewrite every module's import block from what it actually uses.

There is no bundler here, so nothing checks imports until the browser runs. Move
a function between modules and the old module still names it, the new one does
not import what it needs, and you find out one slow page load at a time. This
recomputes the whole graph from the source instead:

    python3 tools/imports.py          # fix them
    python3 tools/imports.py --check  # report, change nothing

Names are found by scanning code with comments and quoted strings removed - a
shop item called 'Monkey Companion' is not a use of the Monkey component, and a
comment mentioning PostFX is not a use of it either. Template literals are left
intact because they carry real markup and GLSL.
"""
import os
import re
import sys

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
DECL = re.compile(r'^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)', re.M)
WORD = re.compile(r'(?<![.\w$])([A-Za-z_$][\w$]*)')
IMPORT = re.compile(r"^import \{[^}]*\} from '\./[a-z]+\.js';\n", re.M)
SIDE_IMPORT = re.compile(r"^import '\./[a-z]+\.js';\n", re.M)
# Whatever core.js re-exports. Read from the file rather than listed here, so
# adding a third-party import in one place is enough.
def _core_exports():
    src = open(os.path.join(SRC, 'core.js'), encoding='utf-8').read()
    m = re.search(r'export \{(.*?)\};', src, re.S)
    return {n.strip() for n in m.group(1).replace('\n', ' ').split(',') if n.strip()} if m else set()


CORE = None


def code_only(text):
    text = re.sub(r'/\*.*?\*/', ' ', text, flags=re.S)
    text = re.sub(r'//[^\n]*', ' ', text)
    text = re.sub(r"'(?:[^'\\\n]|\\.)*'", ' ', text)
    text = re.sub(r'"(?:[^"\\\n]|\\.)*"', ' ', text)
    return text.replace('...', ' ')


def main():
    global CORE
    CORE = _core_exports()
    check = '--check' in sys.argv
    mods = sorted(f[:-3] for f in os.listdir(SRC) if f.endswith('.js') and f != 'core.js')
    bodies, pins, owner = {}, {}, {}
    for mod in mods:
        text = open(os.path.join(SRC, mod + '.js'), encoding='utf-8').read()
        pins[mod] = SIDE_IMPORT.findall(text)
        body = SIDE_IMPORT.sub('', IMPORT.sub('', text))
        bodies[mod] = body.lstrip('\n')
        if mod != 'main':
            for name in DECL.findall(body):
                owner[name] = mod

    changed = []
    for mod in mods:
        body = bodies[mod]
        mine = set(DECL.findall(body))
        by_mod = {}
        for n in sorted(set(WORD.findall(code_only(body))) - mine):
            src_mod = 'core' if n in CORE else owner.get(n)
            if src_mod and src_mod != mod:
                by_mod.setdefault(src_mod, []).append(n)
        head = ''.join(pins[mod])
        if head:
            head += '\n'
        head += ''.join("import { %s } from './%s.js';\n" % (', '.join(sorted(v)), k)
                        for k, v in sorted(by_mod.items()))
        new = head + ('\n' if head and not body.startswith('\n') else '') + body
        path = os.path.join(SRC, mod + '.js')
        if new != open(path, encoding='utf-8').read():
            changed.append(mod)
            if not check:
                open(path, 'w', encoding='utf-8').write(new)

    undeclared = set()
    for mod in mods:
        for n in set(WORD.findall(code_only(bodies[mod]))):
            if n not in owner and n not in CORE and n[0].isupper() and '_' not in n:
                pass  # likely a browser or three global; not our business
    print(('would rewrite ' if check else 'rewrote ') + '%d module(s): %s'
          % (len(changed), ', '.join(changed) if changed else '-'))
    return 1 if (check and changed) else 0


sys.exit(main())
