"""
lead_scorer.py
--------------
Hybrid (rules + LLM) lead quality evaluator for personal-injury intake data.

Pipeline:
  1. Deterministic rules layer — cheap, fast, unambiguous disqualifiers.
     Anything that fails here never touches the LLM (saves cost/latency and
     removes a class of judgment-call errors on hard ethical/legal lines).
  2. LLM judgment layer — for cases that pass the rules, Claude assesses
     liability clarity and financial viability and returns HOT or WARM
     with a confidence score and rationale.

Usage:
    from lead_scorer import LeadScorer, LeadScoreResult

    scorer = LeadScorer()  # reads ANTHROPIC_API_KEY from env
    result: LeadScoreResult = await scorer.score(intake_payload)
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Literal, Optional

import anthropic
from pydantic import BaseModel, Field, field_validator

logger = logging.getLogger("lead_scorer")

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

DEFAULT_STATUTE_OF_LIMITATIONS_YEARS = 2.0

# NOTE: "claude-3-5-sonnet" is a retired model alias. Use a current model
# string (override via ANTHROPIC_SCORING_MODEL if your account needs a
# specific dated snapshot).
DEFAULT_MODEL = os.environ.get("ANTHROPIC_SCORING_MODEL", "claude-sonnet-5")
DEFAULT_MAX_TOKENS = 1024

SCORE_TOOL_NAME = "record_lead_score"

# --------------------------------------------------------------------------- #
# I/O Schemas
# --------------------------------------------------------------------------- #

InjurySeverity = Literal["NONE", "MINOR", "SEVERE", "HOSPITALIZED"]
ScoreStatus = Literal["HOT", "WARM", "COLD"]


class FirmQualificationRules(BaseModel):
    """Firm-specific overrides to the default qualification thresholds."""

    statute_of_limitations_years: float = Field(
        default=DEFAULT_STATUTE_OF_LIMITATIONS_YEARS,
        gt=0,
        description="Max years since incident for the firm to still consider the case.",
    )
    min_confidence_for_hot: float = Field(
        default=0.70,
        ge=0.0,
        le=1.0,
        description="Minimum LLM confidence required to keep a HOT classification.",
    )


class LeadIntake(BaseModel):
    """Input payload — the extracted intake JSON from the intake service."""

    incident_date: str = Field(..., description="Date of incident, ideally ISO 8601 (YYYY-MM-DD).")
    jurisdiction_state: str
    summary_of_facts: str
    injury_severity: InjurySeverity
    currently_represented: bool
    firm_qualification_rules: FirmQualificationRules = Field(
        default_factory=FirmQualificationRules
    )


class LeadScoreResult(BaseModel):
    """Final output of the scoring pipeline."""

    score_status: ScoreStatus
    confidence_score: float = Field(..., ge=0.0, le=1.0)
    rationale: List[str]
    action_recommended: str

    @field_validator("rationale")
    @classmethod
    def non_empty_rationale(cls, value: List[str]) -> List[str]:
        if not value:
            raise ValueError("rationale must contain at least one bullet")
        return value


# --------------------------------------------------------------------------- #
# Action mapping
# --------------------------------------------------------------------------- #

_ACTION_BY_STATUS: Dict[ScoreStatus, str] = {
    "HOT": "Immediate Attorney Call",
    "WARM": "Send Intake Packet",
    "COLD": "Decline Case",
}


def _recommended_action(status: ScoreStatus) -> str:
    return _ACTION_BY_STATUS[status]


# --------------------------------------------------------------------------- #
# Date parsing helper
# --------------------------------------------------------------------------- #

_DATE_FORMATS = (
    "%Y-%m-%d",
    "%m/%d/%Y",
    "%m-%d-%Y",
    "%B %d, %Y",
    "%b %d, %Y",
    "%d %B %Y",
    "%Y/%m/%d",
)


def parse_incident_date(raw_date: str) -> Optional[date]:
    """
    Best-effort parse of a free-form or ISO incident date string.
    Returns None if the date cannot be confidently parsed — callers must
    decide how to treat an unparseable date (this module treats it as
    "cannot verify statute of limitations" and does NOT auto-flag COLD,
    since failing closed on a formatting issue would wrongly kill valid leads).
    """
    cleaned = raw_date.strip()

    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(cleaned, fmt).date()
        except ValueError:
            continue

    # Fallback: pull the first YYYY-MM-DD-like substring out of free text,
    # e.g. "sometime around 2023-04-12 in the parking lot".
    match = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", cleaned)
    if match:
        try:
            return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            return None

    return None


# --------------------------------------------------------------------------- #
# LLM tool schema
# --------------------------------------------------------------------------- #

_SCORE_TOOL: Dict[str, Any] = {
    "name": SCORE_TOOL_NAME,
    "description": (
        "Record the liability/viability assessment for a personal injury lead "
        "that has already passed baseline eligibility checks."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "score": {
                "type": "string",
                "enum": ["HOT", "WARM"],
                "description": (
                    "HOT: liability appears clear and the case looks financially "
                    "viable to pursue. WARM: plausible case but liability is "
                    "unclear, contested, or financial viability is uncertain."
                ),
            },
            "confidence_score": {
                "type": "number",
                "minimum": 0.0,
                "maximum": 1.0,
                "description": "Confidence in the score, 0.00 to 1.00.",
            },
            "rationale": {
                "type": "array",
                "items": {"type": "string"},
                "minItems": 3,
                "maxItems": 3,
                "description": "Exactly three concise bullet points explaining the score.",
            },
        },
        "required": ["score", "confidence_score", "rationale"],
    },
}

_SYSTEM_PROMPT = """\
You are a strict, experienced personal injury case evaluator working for a \
law firm's intake team. You will be given a factual summary and an injury \
severity level for a case that has already passed baseline eligibility \
screening (it is within the statute of limitations, the caller is not \
represented by other counsel, and there is a nonzero injury).

Your job is ONLY to judge:
  1. Liability clarity — how clearly does the summary establish that another \
     party was at fault?
  2. Financial case viability — given the facts and injury severity, does \
     this look like a case worth the firm's resources?

Rules:
- You must call the `record_lead_score` tool exactly once with your assessment. \
  Do not respond in plain text.
- score must be HOT (clear liability + viable damages) or WARM (plausible but \
  uncertain on liability and/or damages). Never output COLD — cases that \
  should be COLD are filtered out before reaching you.
- confidence_score reflects how confident you are in the score itself, not \
  how good the case is.
- rationale must be exactly three short, concrete bullets grounded in the \
  facts given — no boilerplate, no legal advice, no promises about outcomes \
  or case value.
- Be skeptical: vague summaries, unclear fault, or thin injury descriptions \
  should pull the score toward WARM and lower confidence.
"""


# --------------------------------------------------------------------------- #
# LeadScorer
# --------------------------------------------------------------------------- #

class LeadScorer:
    """
    Hybrid deterministic + LLM lead quality evaluator.

    Parameters
    ----------
    api_key:
        Anthropic API key. Falls back to the ANTHROPIC_API_KEY env var.
    model:
        Model string used for the LLM judgment layer.
    client:
        Optionally inject a pre-configured `anthropic.AsyncAnthropic` client
        (useful for testing / connection pooling / sharing across scorers).
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = DEFAULT_MODEL,
        client: Optional[anthropic.AsyncAnthropic] = None,
    ) -> None:
        resolved_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        if client is None and not resolved_key:
            raise ValueError(
                "No Anthropic API key provided. Pass api_key= or set "
                "the ANTHROPIC_API_KEY environment variable."
            )

        self.model = model
        self.client = client or anthropic.AsyncAnthropic(api_key=resolved_key, max_retries=2)

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    async def score(self, payload: Dict[str, Any] | LeadIntake) -> LeadScoreResult:
        """
        Score a lead. Accepts either a raw dict (matching LeadIntake's shape)
        or an already-validated LeadIntake instance.
        """
        intake = payload if isinstance(payload, LeadIntake) else LeadIntake.model_validate(payload)

        cold_result = self._apply_deterministic_rules(intake)
        if cold_result is not None:
            return cold_result

        return await self._apply_llm_judgment(intake)

    # ------------------------------------------------------------------ #
    # Step A — Deterministic rules layer
    # ------------------------------------------------------------------ #

    def _apply_deterministic_rules(self, intake: LeadIntake) -> Optional[LeadScoreResult]:
        """
        Returns a COLD LeadScoreResult if any hard disqualifier applies,
        otherwise None (meaning: proceed to the LLM layer).
        """
        rules = intake.firm_qualification_rules

        if intake.currently_represented:
            return LeadScoreResult(
                score_status="COLD",
                confidence_score=1.0,
                rationale=[
                    "Caller is already represented by another attorney for this matter.",
                    "Soliciting or advising a represented party raises professional "
                    "conduct / ethics concerns.",
                    "Case is disqualified regardless of merits.",
                ],
                action_recommended=_recommended_action("COLD"),
            )

        if intake.injury_severity == "NONE":
            return LeadScoreResult(
                score_status="COLD",
                confidence_score=1.0,
                rationale=[
                    "No injury was reported.",
                    "Personal injury claims require a compensable injury to have value.",
                    "Case does not meet baseline eligibility for this practice area.",
                ],
                action_recommended=_recommended_action("COLD"),
            )

        incident_date = parse_incident_date(intake.incident_date)
        if incident_date is not None:
            years_elapsed = (date.today() - incident_date).days / 365.25
            limit_years = rules.statute_of_limitations_years

            if years_elapsed > limit_years:
                return LeadScoreResult(
                    score_status="COLD",
                    confidence_score=1.0,
                    rationale=[
                        f"Incident occurred {years_elapsed:.1f} years ago "
                        f"({incident_date.isoformat()}).",
                        f"This exceeds the applicable statute-of-limitations "
                        f"window of {limit_years:g} years used for {intake.jurisdiction_state}.",
                        "Case is time-barred and not viable to pursue.",
                    ],
                    action_recommended=_recommended_action("COLD"),
                )
        else:
            logger.warning(
                "Could not parse incident_date=%r — skipping statute-of-limitations "
                "check for this lead; downstream review should verify manually.",
                intake.incident_date,
            )

        return None

    # ------------------------------------------------------------------ #
    # Step B — LLM judgment layer
    # ------------------------------------------------------------------ #

    async def _apply_llm_judgment(self, intake: LeadIntake) -> LeadScoreResult:
        user_message = (
            "Evaluate this case.\n\n"
            f"Injury severity: {intake.injury_severity}\n"
            f"Jurisdiction: {intake.jurisdiction_state}\n"
            f"Summary of facts:\n{intake.summary_of_facts}"
        )

        try:
            response = await self.client.messages.create(
                model=self.model,
                max_tokens=DEFAULT_MAX_TOKENS,
                system=_SYSTEM_PROMPT,
                tools=[_SCORE_TOOL],
                tool_choice={"type": "tool", "name": SCORE_TOOL_NAME},
                messages=[{"role": "user", "content": user_message}],
            )
        except anthropic.APIConnectionError as exc:
            logger.error("Anthropic connection error during scoring: %s", exc)
            return self._fallback_result(
                reason="Could not reach the AI scoring service; routed for manual review."
            )
        except anthropic.RateLimitError as exc:
            logger.warning("Anthropic rate limited during scoring: %s", exc)
            return self._fallback_result(
                reason="AI scoring service is rate-limited; routed for manual review."
            )
        except anthropic.APIStatusError as exc:
            logger.error("Anthropic API error (status=%s) during scoring: %s", exc.status_code, exc)
            return self._fallback_result(
                reason="AI scoring service returned an error; routed for manual review."
            )

        tool_input = self._extract_tool_input(response)
        if tool_input is None:
            logger.error("No %s tool call found in Claude response.", SCORE_TOOL_NAME)
            return self._fallback_result(
                reason="AI scoring service did not return a structured score; routed for manual review."
            )

        return self._parse_llm_output(tool_input, intake)

    @staticmethod
    def _extract_tool_input(response: anthropic.types.Message) -> Optional[Dict[str, Any]]:
        for block in response.content:
            if block.type == "tool_use" and block.name == SCORE_TOOL_NAME:
                return block.input
        return None

    def _parse_llm_output(self, tool_input: Dict[str, Any], intake: LeadIntake) -> LeadScoreResult:
        try:
            score = tool_input["score"]
            confidence = float(tool_input["confidence_score"])
            rationale = list(tool_input["rationale"])

            if score not in ("HOT", "WARM"):
                raise ValueError(f"Unexpected score value from model: {score!r}")
            if not (0.0 <= confidence <= 1.0):
                raise ValueError(f"confidence_score out of range: {confidence!r}")
            if len(rationale) == 0:
                raise ValueError("rationale was empty")

        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            logger.error("Malformed tool output from Claude: %s | raw=%r", exc, tool_input)
            return self._fallback_result(
                reason="AI scoring service returned malformed data; routed for manual review."
            )

        # Firm-defined confidence floor: don't let a low-confidence HOT
        # slip through as an immediate-call priority.
        min_confidence_for_hot = intake.firm_qualification_rules.min_confidence_for_hot
        if score == "HOT" and confidence < min_confidence_for_hot:
            logger.info(
                "Downgrading HOT->WARM: confidence %.2f below firm floor %.2f",
                confidence,
                min_confidence_for_hot,
            )
            score = "WARM"
            rationale = rationale + [
                f"Downgraded from HOT to WARM: model confidence "
                f"({confidence:.2f}) fell below the firm's threshold "
                f"({min_confidence_for_hot:.2f}) for immediate escalation."
            ]

        return LeadScoreResult(
            score_status=score,  # type: ignore[arg-type]
            confidence_score=round(confidence, 2),
            rationale=rationale,
            action_recommended=_recommended_action(score),  # type: ignore[arg-type]
        )

    @staticmethod
    def _fallback_result(reason: str) -> LeadScoreResult:
        """
        Safe default when the LLM layer fails outright. WARM + manual review
        rather than silently dropping the lead or auto-declining it — an
        infrastructure failure should never masquerade as "this case is bad."
        """
        return LeadScoreResult(
            score_status="WARM",
            confidence_score=0.0,
            rationale=[
                reason,
                "Automated scoring could not be completed for this lead.",
                "A human reviewer should evaluate liability and viability directly.",
            ],
            action_recommended="Send Intake Packet",
        )
