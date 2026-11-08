"""The system drive rule for builds, in one place.

By default the build tools keep the Rust toolchain, the caches and the build output off C: (a small
system drive fills up fast: the object cache alone can take 30 GB). A machine with one drive sets
DHD_ALLOW_SYSTEM_DRIVE=1 and builds on C: like anywhere else; the caches then live where
DHD_DEVCACHES, CARGO_HOME and RUSTUP_HOME say (their defaults under the home folder)."""
import os

ALLOWED = os.environ.get('DHD_ALLOW_SYSTEM_DRIVE', '') == '1'
HOW = ' (set DHD_ALLOW_SYSTEM_DRIVE=1 to build on C:)'


def on_system_drive(path):
    """True when path is on C: (or WSL's /mnt/c), unless DHD_ALLOW_SYSTEM_DRIVE=1 lifts the rule."""
    if ALLOWED:
        return False
    p = os.path.abspath(str(path))
    return os.path.splitdrive(p)[0].upper() == 'C:' or p.replace('\\', '/').startswith('/mnt/c/')
