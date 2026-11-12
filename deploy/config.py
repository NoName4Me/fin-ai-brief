#!/usr/bin/env python3
"""Generate and validate the private, unquoted deployment environment file."""
import hashlib
import json
import re
import ipaddress
import os
from pathlib import Path
import secrets
import sys


def read(path):
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator:
            raise ValueError('配置文件包含无效行')
        values[key.strip()] = value.strip()
    return values


def validate(values):
    port = int(values.get('HTTP_PORT', '80'))
    if not 1 <= port <= 65535:
        raise ValueError('HTTP_PORT 必须在 1 到 65535 之间')
    ipaddress.ip_address(values.get('BIND_ADDRESS', '0.0.0.0'))
    network = ipaddress.ip_network(values.get('ACCESS_CIDR', ''), strict=False)
    if network.prefixlen == 0:
        raise ValueError('ACCESS_CIDR 请填写办公IP或可信网段，不要开放给全网')
    for key, length in [('POSTGRES_PASSWORD', 32), ('APP_DB_PASSWORD', 32), ('ADMIN_PASSWORD', 12)]:
        value = values.get(key, '')
        if len(value) < length or not all(c in '0123456789abcdefABCDEF' for c in value):
            raise ValueError(f'{key} 请使用 init 生成的十六进制值，长度至少{length}位')
    # Existing installations may use a non-hex signing key. Preserve it during migration.
    if not re.fullmatch(r'[A-Za-z0-9_+/=.-]{32,}', values.get('APP_SECRET', '')):
        raise ValueError('APP_SECRET 至少32位，只支持字母、数字及 _ + / = . -')
    for key, value in values.items():
        if any(c in value for c in ['\n', '\r', '$', '"', "'"]):
            raise ValueError(f'{key} 包含不支持的字符；私钥请填写去掉PEM头尾和换行的Base64正文')


def release(path, verify=False):
    root = path.resolve()
    value = json.loads((root / 'release/manifest.json').read_text())
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]+', value.get('version', '')):
        raise ValueError('部署包版本无效')
    if value.get('platform') not in ['linux/amd64', 'linux/arm64']:
        raise ValueError('部署包平台无效')
    # Packages made before update/full modes always contained all four images.
    value.setdefault('mode', 'full')
    if value['mode'] not in ['full', 'update']:
        raise ValueError('部署包类型无效')
    for key, prefix in [('postgres_image', 'fin-ai-brief-postgres:'), ('nginx_image', 'fin-ai-brief-nginx:')]:
        if value['mode'] == 'update':
            if value.get(key):
                raise ValueError('更新包不应指定基础镜像；请使用服务器现有镜像')
            value[key] = ''
        elif not re.fullmatch(re.escape(prefix) + r'[A-Za-z0-9._-]+', value.get(key, '')):
            raise ValueError('部署包基础镜像名称无效')
    if verify:
        if 'release/images.tar' not in value['files']:
            raise ValueError('部署包缺少镜像')
        for name, expected in value['files'].items():
            file = (root / name).resolve()
            if not file.is_relative_to(root) or not file.is_file():
                raise ValueError('部署包文件路径无效')
            digest = hashlib.sha256()
            with file.open('rb') as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                    digest.update(chunk)
            if digest.hexdigest() != expected:
                raise ValueError(f'部署包校验失败: {name}')
    return value

def main():
    command, filename, *args = sys.argv[1:]
    path = Path(filename)
    if command == 'verify-release':
        release(path, verify=True)
    elif command == 'release-value':
        print(release(path)[args[0]])
    elif command == 'init':
        if path.exists():
            raise ValueError('配置文件已存在，未覆盖')
        if len(args) != 2:
            raise ValueError('用法: init HTTP_PORT 办公IP/32')
        port, cidr = args
        values = read(Path(__file__).with_name('.env.example'))
        values.update(HTTP_PORT=port, ACCESS_CIDR=cidr)
        for key in ['POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'ADMIN_PASSWORD', 'APP_SECRET']:
            values[key] = secrets.token_hex(32)
        validate(values)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write('\n'.join(f'{k}={v}' for k, v in values.items()) + '\n')
        print(f'已生成 {path}，权限600。管理员密码在 ADMIN_PASSWORD 中。')
    elif command == 'validate':
        validate(read(path))
    else:
        raise ValueError('未知操作')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, IndexError) as error:
        sys.exit(str(error))
