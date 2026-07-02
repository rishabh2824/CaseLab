from pydantic import BaseModel


class StartSimulationPayload(BaseModel):
    access_code: str


class SendMessagePayload(BaseModel):
    persona_id: str
    message: str
