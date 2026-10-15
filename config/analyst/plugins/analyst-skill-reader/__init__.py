"""Expose Hermes's existing skill readers as a read-only toolset."""

from toolsets import create_custom_toolset


def register(ctx):
    create_custom_toolset(
        "analyst-skill-reader",
        "Read installed Analyst workflow instructions",
        tools=["skills_list", "skill_view"],
    )
