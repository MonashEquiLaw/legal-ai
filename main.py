"""
AI-Powered Legal Intake Service
--------------------------------
A FastAPI microservice that runs a multi-turn, tool-augmented conversation
with Claude to perform personal-injury legal intake. Claude gathers the
required facts conversationally and, once it has enough information,
calls the `submit_completed_intake` tool instead of replying in prose.
That tool call is what the backend uses to know the interview is done.

Run:
    export ANTHROPIC_API_KEY=sk-ant-...
    uvicorn intake_service:app --reload
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Literal, Optional

import anthropic
from fastapi import FastAPI, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("intake_service")

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
if not ANTHROPIC_API_KEY:
    # Fail loudly at startup rather than on the first request.
    raise RuntimeError(
        "ANTHROPIC_API_KEY environment variable is not set. "
        "Set it before starting the service."
    )

MODEL_NAME = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5")
MAX_TOKENS = int(os.environ.get("ANTHROPIC_MAX_TOKENS", "1024"))
REQUEST_TIMEOUT_SECONDS = float(os.environ.get("ANTHROPIC_TIMEOUT", "30"))

# Single shared async client for the life of the process.
client = anthropic.AsyncAnthropic(
    api_key=ANTHROPIC_API_KEY,
    timeout=REQUEST_TIMEOUT_SECONDS,
    max_retries=2,
)

app = FastAPI(
    title="Legal Intake AI Service",
    version="1.0.0",
    description="Conversational personal-injury intake powered by Claude tool use.",
)

# --------------------------------------------------------------------------- #
# Tool definition
# --------------------------------------------------------------------------- #

SUBMIT_INTAKE_TOOL: Dict[str, Any] = {
    "name": "submit_completed_intake",
    "description": (
        "Call this ONLY when you have collected enough information to close "
        "out the intake interview: the incident date and location, a clear "
        "description of what happened / liability, the extent of injuries "
        "and any medical treatment received, whether the caller is already "
        "represented by an attorney, and enough contact details to follow "
        "up. Do not call this while questions remain unanswered or answers "
        "are vague — ask a clarifying follow-up instead."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "client_first_name": {
                "type": "string",
                "description": "Caller's first name.",
            },
            "client_last_name": {
                "type": "string",
                "description": "Caller's last name.",
            },
            "client_phone": {
                "type": "string",
                "description": "Best callback phone number, as given by the caller.",
            },
            "client_email": {
                "type": "string",
                "description": "Caller's email address.",
            },
            "incident_date": {
                "type": "string",
                "description": "Date the incident occurred (caller's own words or ISO format if known).",
            },
            "jurisdiction_state": {
                "type": "string",
                "description": "U.S. state (or jurisdiction) where the incident occurred.",
            },
            "summary_of_facts": {
                "type": "string",
                "description": (
                    "Concise third-person summary of what happened and why the "
                    "other party may be liable, based on the caller's account."
                ),
            },
            "injury_severity": {
                "type": "string",
                "enum": ["NONE", "MINOR", "SEVERE", "HOSPITALIZED"],
                "description": "Best-fit severity bucket for the injuries described.",
            },
            "currently_represented": {
                "type": "boolean",
                "description": "True if the caller already has an attorney for this matter.",
            },
        },
        "required": [
            "client_first_name",
            "client_last_name",
            "client_phone",
            "client_email",
            "incident_date",
            "jurisdiction_state",
            "summary_of_facts",
            "injury_severity",
            "currently_represented",
        ],
    },
}

SYSTEM_PROMPT = """\
You are an empathetic, professional legal intake coordinator for a personal \
injury law firm. You are speaking with a potential client who may be \
stressed, injured, or unsure what information is relevant. Your job is to \
run a warm, natural conversation that collects everything the firm's \
attorneys need to evaluate the case.

Ground rules:
- Ask ONE question at a time. Never stack multiple questions in one message.
- Acknowledge what the caller just told you before asking the next question, \
  so the conversation feels human rather than like a form.
- Do not give legal advice, predict case value, or guarantee any outcome. \
  You are gathering facts only; an attorney will follow up.
- Over the course of the conversation you must gather:
    (a) The date and location of the incident.
    (b) A description of what happened and who may be liable.
    (c) The extent of the caller's injuries and any medical treatment received.
    (d) Whether the caller is already represented by an attorney for this matter.
    (e) Enough contact information (first name, last name, phone, email) to \
        follow up.
- If the caller has already volunteered a piece of information, do not ask \
  for it again.
- Once — and only once — you have gathered all of the above with enough \
  specificity to be useful to an attorney, call the `submit_completed_intake` \
  tool with the structured data instead of replying in plain text. Do not \
  narrate that you are about to submit it; just call the tool.
- If the caller describes a medical emergency or ongoing danger, gently \
  advise them to call 911 or seek immediate medical care before continuing \
  the intake.
"""

# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #

class HistoryTurn(BaseModel):
    """A single prior turn in the conversation."""

    role: Literal["user", "assistant"]
    content: str


class IntakeMessageRequest(BaseModel):
    session_id: str = Field(..., description="Unique identifier for this intake conversation.")
    firm_id: str = Field(..., description="Identifier of the law firm running this intake.")
    practice_area: str = Field(..., description="Practice area context, e.g. 'personal_injury'.")
    user_message: str = Field(..., min_length=1, description="The caller's latest message.")
    history: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="Prior turns as [{'role': 'user'|'assistant', 'content': str}, ...].",
    )

    @field_validator("history")
    @classmethod
    def validate_history_shape(cls, value: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        for i, turn in enumerate(value):
            if "role" not in turn or "content" not in turn:
                raise ValueError(f"history[{i}] must contain 'role' and 'content'")
            if turn["role"] not in ("user", "assistant"):
                raise ValueError(f"history[{i}].role must be 'user' or 'assistant'")
        return value


class MessageResponse(BaseModel):
    type: Literal["message"] = "message"
    response: str
    session_id: str


class CompletedIntakeData(BaseModel):
    client_first_name: str
    client_last_name: str
    client_phone: str
    client_email: str
    incident_date: str
    jurisdiction_state: str
    summary_of_facts: str
    injury_severity: Literal["NONE", "MINOR", "SEVERE", "HOSPITALIZED"]
    currently_represented: bool


class CompletedResponse(BaseModel):
    type: Literal["completed"] = "completed"
    data: CompletedIntakeData
    session_id: str
    lead_evaluation: Optional[Dict[str, Any]] = None


# --------------------------------------------------------------------------- #
# Lead evaluation pipeline (stubbed integration point)
# --------------------------------------------------------------------------- #

async def evaluate_lead(firm_id: str, session_id: str, data: CompletedIntakeData) -> Dict[str, Any]:
    """
    Placeholder for the downstream lead-scoring / CRM pipeline.

    In production this would likely:
      - Persist the intake to a database.
      - Push the lead into the firm's CRM (e.g. Clio, Salesforce).
      - Run case-value / eligibility heuristics.
      - Notify an intake specialist (email/Slack/SMS) for urgent cases.

    Kept synchronous-looking but async so it can be swapped for real I/O
    without changing the call site.
    """
    try:
        priority = "high" if data.injury_severity in ("SEVERE", "HOSPITALIZED") else "standard"
        logger.info(
            "Lead evaluated | firm=%s session=%s severity=%s represented=%s priority=%s",
            firm_id,
            session_id,
            data.injury_severity,
            data.currently_represented,
            priority,
        )
        return {
            "priority": priority,
            "accepted_for_review": not data.currently_represented,
            "notes": (
                "Caller reports existing representation; route to conflicts/referral queue."
                if data.currently_represented
                else "No existing representation reported; route to attorney review queue."
            ),
        }
    except Exception:  # pragma: no cover - defensive, pipeline is a stub
        logger.exception("Lead evaluation pipeline failed for session=%s", session_id)
        return {"priority": "unknown", "accepted_for_review": False, "notes": "Evaluation failed."}


# --------------------------------------------------------------------------- #
# Claude orchestration
# --------------------------------------------------------------------------- #

def _build_messages(history: List[Dict[str, Any]], user_message: str) -> List[Dict[str, str]]:
    """Flatten stored history + the new user turn into Messages API format."""
    messages: List[Dict[str, str]] = []
    for turn in history:
        messages.append({"role": turn["role"], "content": turn["content"]})
    messages.append({"role": "user", "content": user_message})
    return messages


def _extract_tool_call(response: anthropic.types.Message) -> Optional[Dict[str, Any]]:
    """Return the parsed input of the submit_completed_intake tool call, if present."""
    for block in response.content:
        if block.type == "tool_use" and block.name == "submit_completed_intake":
            return block.input  # already parsed dict, per Anthropic SDK
    return None


def _extract_text(response: anthropic.types.Message) -> str:
    """Concatenate all text blocks in the response."""
    return "".join(block.text for block in response.content if block.type == "text").strip()


async def run_intake_turn(request: IntakeMessageRequest) -> anthropic.types.Message:
    """Send the conversation so far to Claude with the intake tool available."""
    messages = _build_messages(request.history, request.user_message)

    try:
        response = await client.messages.create(
            model=MODEL_NAME,
            max_tokens=MAX_TOKENS,
            system=SYSTEM_PROMPT,
            messages=messages,
            tools=[SUBMIT_INTAKE_TOOL],
        )
        return response

    except anthropic.APIConnectionError as exc:
        logger.error("Anthropic connection error for session=%s: %s", request.session_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not reach the AI provider. Please try again shortly.",
        ) from exc

    except anthropic.RateLimitError as exc:
        logger.warning("Anthropic rate limited for session=%s: %s", request.session_id, exc)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="The intake assistant is temporarily busy. Please retry shortly.",
        ) from exc

    except anthropic.APIStatusError as exc:
        logger.error(
            "Anthropic API error (status=%s) for session=%s: %s",
            exc.status_code,
            request.session_id,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The AI provider returned an error.",
        ) from exc


# --------------------------------------------------------------------------- #
# Endpoint
# --------------------------------------------------------------------------- #

@app.post(
    "/api/v1/intake/chat",
    response_model=None,  # response shape varies by branch; validated manually below
    status_code=status.HTTP_200_OK,
    summary="Advance an AI-driven legal intake conversation by one turn.",
)
async def intake_chat(payload: IntakeMessageRequest) -> JSONResponse:
    logger.info(
        "Intake turn | firm=%s session=%s practice_area=%s",
        payload.firm_id,
        payload.session_id,
        payload.practice_area,
    )

    response = await run_intake_turn(payload)

    tool_input = _extract_tool_call(response)

    if tool_input is not None:
        try:
            completed_data = CompletedIntakeData.model_validate(tool_input)
        except Exception as exc:
            logger.error(
                "Malformed submit_completed_intake payload for session=%s: %s",
                payload.session_id,
                exc,
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="The AI produced an invalid intake payload.",
            ) from exc

        lead_result = await evaluate_lead(payload.firm_id, payload.session_id, completed_data)

        result = CompletedResponse(
            data=completed_data,
            session_id=payload.session_id,
            lead_evaluation=lead_result,
        )
        return JSONResponse(content=result.model_dump())

    text = _extract_text(response)
    if not text:
        # Claude returned neither text nor the expected tool call.
        logger.warning("Empty assistant response for session=%s", payload.session_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The AI assistant did not return a usable response.",
        )

    result = MessageResponse(response=text, session_id=payload.session_id)
    return JSONResponse(content=result.model_dump())


@app.get("/healthz", summary="Liveness probe")
async def healthz() -> Dict[str, str]:
    return {"status": "ok"}
