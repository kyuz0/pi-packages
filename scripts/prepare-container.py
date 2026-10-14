"""Apply version-checked container adaptations to pinned remote packages."""
import hashlib
import io
import json
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile
import urllib.request

root = Path(__file__).resolve().parents[1]
modules = root / 'node_modules'
sources = json.loads((root / 'scripts/container-sources.json').read_text())


def remote(name):
    spec = sources[name]
    with urllib.request.urlopen(spec['url'], timeout=120) as response:
        blob = response.read()
    if hashlib.sha256(blob).hexdigest() != spec['sha256']:
        raise RuntimeError('Remote source checksum mismatch: ' + name)
    return tarfile.open(fileobj=io.BytesIO(blob), mode='r:gz')


def member(archive, name):
    matches = [m for m in archive.getmembers() if m.name.split('/', 1)[-1] == name and m.isfile()]
    if len(matches) != 1:
        raise RuntimeError('Missing/ambiguous source: ' + name)
    return archive.extractfile(matches[0]).read()


def replace(path, old, new):
    path = modules / path
    text = path.read_text()
    if text.count(old) != 1:
        raise RuntimeError('Patch no longer matches exactly: ' + str(path))
    path.write_text(text.replace(old, new))


# Bubblewrap 0.13 uses mount_setattr for read-only binds, which works inside
# rootless SELinux containers where legacy remount operations are denied.
with remote('bubblewrap') as source, tempfile.TemporaryDirectory() as tmp:
    build = Path(tmp)
    for entry in source.getmembers():
        parts = Path(entry.name).parts[1:]
        if not parts or '..' in parts or entry.isdir():
            continue
        if not entry.isfile():
            raise RuntimeError('Unexpected Bubblewrap source entry: ' + entry.name)
        target = build.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.extractfile(entry).read())
        target.chmod(entry.mode & 0o755)
    subprocess.run(['meson', 'setup', str(build / 'build'), str(build), '--prefix=/usr/local',
                    '-Dtests=false', '-Dman=disabled', '-Dbash_completion=disabled',
                    '-Dzsh_completion=disabled'], check=True)
    subprocess.run(['ninja', '-C', str(build / 'build'), 'install'], check=True)

# Fail closed on dependency updates: every edit must match exactly once.
assert json.loads((modules / '@anthropic-ai/sandbox-runtime/package.json').read_text())['version'] == '0.0.79'
assert json.loads((modules / '@gotgenes/pi-permission-system/package.json').read_text())['version'] == '40.2.0'
replace('@gotgenes/pi-permission-system/src/config/config-paths.ts',
        'return join(getGlobalConfigDir(agentDir), "config.json");',
        'return process.env.PI_SANDBOX_CONTAINER === "1" ? "/opt/pi-security/config/permissions.json" : join(getGlobalConfigDir(agentDir), "config.json");')
replace('@gotgenes/pi-permission-system/src/config/config-loader.ts',
        'const includeProjectScope = options.includeProjectScope !== false;',
        'const includeProjectScope = process.env.PI_SANDBOX_CONTAINER !== "1" && options.includeProjectScope !== false;')
replace('@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js',
        "bwrapArgs.push('--dev', '/dev');",
        "bwrapArgs.push('--dev-bind', '/dev', '/dev'); // isolated outer-container devices")
# A read-only regular empty file masks denied paths without attempting to bind
# a device inode onto the workspace, which SELinux denies in rootless containers.
mask = root / 'empty-mask'
mask.write_bytes(b'')
mask.chmod(0o444)
p = modules / '@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js'
s = p.read_text()
assert s.count("'/dev/null'") == 7, s.count("'/dev/null'")
p.write_text(s.replace("'/dev/null'", repr(str(mask))))

# Keep the upstream PID/user namespace and seccomp implementation. SELinux can
# report EACCES for the same denied nested proc remount that upstream handles
# as EPERM. Only that remount gets the existing nested-container fallback.
with remote('sandbox-runtime') as source, tempfile.TemporaryDirectory() as tmp:
    build = Path(tmp)
    for name in ('apply-seccomp.c', 'seccomp-unix-block.c'):
        (build / name).write_bytes(member(source, 'vendor/seccomp-src/' + name))
    path = build / 'apply-seccomp.c'
    code = path.read_text()
    old = '&& errno != EPERM) {\n        die("apply-seccomp: mount(/proc)");'
    assert code.count(old) == 1
    path.write_text(code.replace(old, '&& errno != EPERM && errno != EACCES) {\n        die("apply-seccomp: mount(/proc)");'))
    machine = platform.machine()
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}[machine]
    subprocess.run(['gcc', '-static', '-O2', '-o', str(build / 'generate'), str(build / 'seccomp-unix-block.c'), '-lseccomp'], check=True)
    subprocess.run([str(build / 'generate'), str(build / 'filter.bpf'), machine], check=True)
    data = (build / 'filter.bpf').read_bytes()
    (build / 'unix-block-bpf.h').write_text('static const unsigned char unix_block_bpf[] = {' + ','.join(str(b) for b in data) + '};\n')
    output = modules / '@anthropic-ai/sandbox-runtime/vendor/seccomp' / arch / 'apply-seccomp'
    subprocess.run(['gcc', '-static', '-O2', '-Wall', '-Wextra', '-I', tmp, '-o', str(output), str(path)], check=True)
    subprocess.run(['strip', str(output)], check=True)
print('Prepared pinned security packages and nested-container adaptations')
