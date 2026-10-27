"""Exercise backup source selection without a database or Docker daemon."""

import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parent / "backup.sh"


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.media = self.root / "uploads"
        for name in ("videos/case.mp4", "screens/T-1/1.webm", "gaze/T-1/1/0.ndjson"):
            path = self.media / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name)
        self.command(
            "pg_dump",
            'from pathlib import Path\nimport sys\n'
            'Path(sys.argv[sys.argv.index("--file") + 1]).write_text("database")\n',
        )
        self.command("docker", 'import sys\nsys.exit(1)\n')
        self.env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "UPLOADS_DIR": str(self.media),
            "BACKUP_MEDIA_MODE": "local",
        }

    def command(self, name, body):
        path = self.bin / name
        path.write_text("#!/usr/bin/env python3\n" + body)
        path.chmod(0o755)

    def run_backup(self):
        return subprocess.run(
            ["bash", str(SCRIPT), str(self.root / "backups")],
            env=self.env,
            capture_output=True,
            text=True,
        )

    def assert_media_present(self):
        archive, = (self.root / "backups").glob("uploads-*.tar.gz")
        with tarfile.open(archive) as content:
            names = set(content.getnames())
        self.assertIn("uploads/videos/case.mp4", names)
        self.assertIn("uploads/screens/T-1/1.webm", names)
        self.assertIn("uploads/gaze/T-1/1/0.ndjson", names)
        self.assertEqual(len(list((self.root / "backups").glob("a04-*.dump"))), 1)

    def test_local_backs_up_every_media_kind(self):
        result = self.run_backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_media_present()

    def test_missing_media_fails_without_publishing_database_only_backup(self):
        self.env["UPLOADS_DIR"] = str(self.root / "missing")
        result = self.run_backup()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(list((self.root / "backups").glob("*.dump")))

    def test_compose_auto_uses_existing_mount_instead_of_host_directory(self):
        self.env.pop("UPLOADS_DIR")
        self.env["BACKUP_MEDIA_MODE"] = "auto"
        self.env["MEDIA_PARENT"] = str(self.root)
        self.command(
            "docker",
            'import os, subprocess, sys\n'
            'args = sys.argv[1:]\n'
            'if args[0] == "compose": print("backend-container")\n'
            'elif args[0] == "inspect":\n'
            ' print("backend-image" if args[2] == "{{.Image}}" else "/volume/uploads")\n'
            'elif args[0] == "run":\n'
            ' assert "backend-container:ro" in args\n'
            ' sys.exit(subprocess.call(["tar", "-czf", "-", "-C", os.environ["MEDIA_PARENT"], "uploads"]))\n',
        )
        result = self.run_backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("uploads (compose)", result.stdout)
        self.assert_media_present()

    def test_failed_dump_leaves_no_completed_pair(self):
        self.command("pg_dump", 'import sys\nsys.exit(1)\n')
        result = self.run_backup()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list((self.root / "backups").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
