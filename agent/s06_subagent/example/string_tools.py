#!/usr/bin/env python3
"""
string_tools.py - String utility functions for subagent usage.

Provides slugify() for converting arbitrary text into URL-friendly slugs.
"""

import re


def slugify(text: str) -> str:
    """
    Convert arbitrary text into a URL-friendly slug.

    Rules:
      - Convert to lowercase
      - Replace any run of non-alphanumeric characters (except hyphens) with a single hyphen
      - Strip leading/trailing hyphens
      - Limit to 80 characters

    Examples:
      >>> slugify("Hello World")
      'hello-world'
      >>> slugify("  Python 3.9 & 3.10  ")
      'python-39-310'
      >>> slugify("What's new in AI?")
      'whats-new-in-ai'
      >>> slugify("---Hello---World---")
      'hello-world'
      >>> slugify("A" * 100)
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    """
    # Lowercase
    text = text.lower()
    # Replace any non-alphanumeric, non-hyphen character with a hyphen
    text = re.sub(r"[^a-z0-9-]", "-", text)
    # Collapse multiple consecutive hyphens into one
    text = re.sub(r"-+", "-", text)
    # Strip leading and trailing hyphens
    text = text.strip("-")
    # Limit length
    text = text[:80]
    return text


if __name__ == "__main__":
    # Self-test when run directly
    import sys

    test_cases = [
        ("Hello World", "hello-world"),
        ("  Python 3.9 & 3.10  ", "python-3-9-3-10"),
        ("What's new in AI?", "what-s-new-in-ai"),
        ("---Hello---World---", "hello-world"),
        ("Simple", "simple"),
        ("", ""),
        ("A" * 100, "a" * 80),
        ("Café & résumé", "caf-r-sum"),
    ]

    all_passed = True
    for text, expected in test_cases:
        result = slugify(text)
        status = "PASS" if result == expected else "FAIL"
        if status == "FAIL":
            all_passed = False
            print(f"  {status}: slugify({text!r})")
            print(f"         expected: {expected!r}")
            print(f"         got:      {result!r}")
        else:
            print(f"  {status}: {text!r} -> {result!r}")

    print()
    if all_passed:
        print("All tests passed!")
        sys.exit(0)
    else:
        print("Some tests failed!")
        sys.exit(1)
