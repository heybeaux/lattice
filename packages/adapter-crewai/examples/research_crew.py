"""Example: 3-agent research crew with Lattice coordination.

Run with:
    OPENAI_API_KEY=sk-... python examples/research_crew.py
"""
import os

from crewai import Agent, Crew, Process, Task

from lattice_crewai import BreakerConfig, LatticeCrewMiddleware, configure_task

openai_key = os.environ["OPENAI_API_KEY"]

# --- Agents ---

researcher = Agent(
    role="Researcher",
    goal="Find the most relevant and up-to-date information on a topic",
    backstory="Expert at synthesizing research from multiple sources",
    verbose=True,
)

analyst = Agent(
    role="Analyst",
    goal="Identify patterns and insights from research data",
    backstory="Data scientist with deep expertise in trend analysis",
    verbose=True,
)

writer = Agent(
    role="Writer",
    goal="Write clear, engaging content from research and analysis",
    backstory="Technical writer who makes complex topics accessible",
    verbose=True,
)

# --- Tasks ---

research_task = Task(
    description="Research the current state of multi-agent AI coordination frameworks. Focus on adoption trends, key players, and technical approaches.",
    expected_output="A structured summary of key findings with citations",
    agent=researcher,
)

analysis_task = Task(
    description="Analyze the research findings. Identify the top 3 trends and what they mean for enterprise adoption over the next 12 months.",
    expected_output="A trend analysis with supporting data points",
    agent=analyst,
)

# Creative task — structural similarity to input is low, so skip L2
writing_task = configure_task(
    Task(
        description="Write a 500-word executive brief on the future of multi-agent AI coordination, based on the research and analysis.",
        expected_output="A polished executive brief suitable for a CTO audience",
        agent=writer,
    ),
    skip_l2=True,  # output is stylistically different from input — L2 would be noisy
)

# --- Crew + Lattice ---

crew = Crew(
    agents=[researcher, analyst, writer],
    tasks=[research_task, analysis_task, writing_task],
    process=Process.sequential,
    verbose=True,
)

wrapped = LatticeCrewMiddleware(
    crew,
    audit_log_path="./lattice-audit.jsonl",
    openai_api_key=openai_key,
    shadow=False,  # set True to observe without blocking
)

result = wrapped.kickoff(inputs={"topic": "multi-agent AI coordination"})

print("\n--- Final Output ---")
print(result.raw)
print("\n--- Audit log written to ./lattice-audit.jsonl ---")
