"""Check production build settings without starting containers or reading secrets."""

import json
import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GUARD = "VITE_LAB_DISPLAY_GUARD"


class LrzConfigTests(unittest.TestCase):
    def render(self, guard=None, env_file=None):
        env = {
            **os.environ,
            "RELEASE_ID": "config-test",
            "DATA_ROOT": "/tmp/a04-config-test",
            "A04_ORIGIN": "https://a04.example.invalid",
            "DATABASE_URL": "postgresql+asyncpg://test:test@db/test",
            "JWT_SECRET": "synthetic-config-test-secret-not-for-deployment",
        }
        env.pop(GUARD, None)
        if guard is not None:
            env[GUARD] = guard
        result = subprocess.run(
            [
                "docker",
                "compose",
                "--env-file",
                str(env_file or os.devnull),
                "--profile",
                "tools",
                "-f",
                str(ROOT / "infrastructure/lrz/compose.yml"),
                "config",
                "--format",
                "json",
            ],
            env=env,
            capture_output=True,
            text=True,
            check=True,
        )
        services = json.loads(result.stdout)["services"]
        for name in ("api", "migrate"):
            self.assertEqual(
                services[name]["environment"]["CALIBRATION_ENABLED"], "false"
            )
        return services["web"]["build"]["args"]

    def test_existing_environment_enables_guard_without_a_new_setting(self):
        self.assertEqual(self.render()[GUARD], "true")

    def test_empty_setting_keeps_the_lab_default(self):
        self.assertEqual(self.render("")[GUARD], "true")

    def test_explicit_disable_reaches_the_web_build(self):
        self.assertEqual(self.render("false")[GUARD], "false")

    def test_example_environment_enables_guard(self):
        example = ROOT / "infrastructure/lrz/deployment.env.example"
        self.assertIn(f"{GUARD}=true", example.read_text().splitlines())
        self.assertEqual(self.render(env_file=example)[GUARD], "true")

    def test_generic_docker_build_is_opt_in_and_passes_the_flag_to_vite(self):
        build_stage = (ROOT / "frontend/Dockerfile").read_text().split("\nFROM ", 2)[1]
        instructions = build_stage.splitlines()
        arg = instructions.index(f"ARG {GUARD}=false")
        env = instructions.index(f"ENV {GUARD}=${GUARD}")
        build = instructions.index("RUN npm run build")
        self.assertLess(arg, env)
        self.assertLess(env, build)


if __name__ == "__main__":
    unittest.main()
