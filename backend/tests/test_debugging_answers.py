import pytest

from app.models.enums import QuestionnairePlacement
from app.models.questionnaire import Questionnaire


@pytest.mark.asyncio
async def test_debugging_response_rejects_six_entries_and_accepts_five(
    client, db, seed_study, participant_headers
):
    questionnaire = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.pre_test,
        title="CK",
        questions=[
            {"id": "ck", "type": "debugging", "text": "Fehler?", "max": 29, "max_entries": 5}
        ],
    )
    db.add(questionnaire)
    await db.flush()
    path = f"/participant/questionnaires/{questionnaire.id}/respond"
    response = await client.post(
        path,
        headers=participant_headers,
        json={"answers": {"ck": {"lines": [1, 2, 3, 4, 5, 6], "explanation": "Fehler"}}},
    )
    assert response.status_code == 422
    response = await client.post(
        path,
        headers=participant_headers,
        json={"answers": {"ck": {"lines": [1, 2, 3, 4, 5], "explanation": "Fehler"}}},
    )
    assert response.status_code == 201
