"""Contract checks for full-perimeter, daylight-visible compass guidance."""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True


ROOT = Path(__file__).resolve().parents[1]


class GuidanceTint360ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = (ROOT / "app.js").read_text(encoding="utf-8")
        cls.styles = (ROOT / "styles.css").read_text(encoding="utf-8")

    def test_glow_uses_a_full_viewport_perimeter_position(self) -> None:
        tint_rule = re.search(r"\.guidance-tint\s*\{([\s\S]*?)\n\}", self.styles)
        self.assertIsNotNone(tint_rule)
        rule = tint_rule.group(1)
        self.assertIn("inset: 0;", rule)
        self.assertIn("at var(--guidance-x) var(--guidance-y)", rule)
        self.assertIn("pointer-events: none;", rule)
        self.assertNotIn("--guidance-offset", self.app + self.styles)
        self.assertIn("Math.sin(radians)", self.app)
        self.assertIn("Math.cos(radians)", self.app)
        self.assertIn('setProperty("--guidance-x"', self.app)
        self.assertIn('setProperty("--guidance-y"', self.app)
        self.assertRegex(self.styles, r"@property --guidance-x[\s\S]*?syntax: \"<percentage>\"")
        self.assertRegex(self.styles, r"@property --guidance-y[\s\S]*?syntax: \"<percentage>\"")

    def test_brightness_and_blur_remain_strong_across_full_turn(self) -> None:
        opacity = {
            int(error): float(value)
            for error, value in re.findall(
                r"--guidance-opacity-(\d+):\s*([0-9.]+);", self.styles
            )
        }
        blur = {
            int(error): float(value)
            for error, value in re.findall(
                r"--guidance-blur-(\d+):\s*([0-9.]+);", self.styles
            )
        }
        self.assertEqual({0, 30, 60, 110, 180}, set(opacity))
        self.assertGreaterEqual(min(opacity.values()), 0.60)
        self.assertLessEqual(max(opacity.values()) - min(opacity.values()), 0.12)
        self.assertGreater(opacity[0], opacity[180])
        self.assertLessEqual(max(blur.values()) - min(blur.values()), 1.0)
        self.assertLessEqual(max(blur.values()), 5.0)
        self.assertIn("brightness(1);", self.styles)

    def test_desk_preview_and_reduced_motion_keep_direction_information(self) -> None:
        self.assertIn("window.previewGuidanceHeadingError = previewGuidanceHeadingError", self.app)
        self.assertIn('.get("guidanceError")', self.app)
        self.assertIn("Math.max(-180, Math.min(180, parsedError))", self.app)
        reduced_blocks = re.findall(
            r"@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}",
            self.styles,
        )
        block = next((item for item in reduced_blocks if ".guidance-tint" in item), "")
        self.assertTrue(block)
        self.assertIn("animation: none;", block)
        self.assertIn("--guidance-x 0ms", block)
        self.assertIn("--guidance-y 0ms", block)
        self.assertNotIn("opacity: 0", block)


if __name__ == "__main__":
    unittest.main()
