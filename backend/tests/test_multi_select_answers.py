import pytest
from sqlalchemy import select

from app.models.enums import QuestionnairePlacement
from app.models.questionnaire import Questionnaire, QuestionnaireResponse


@pytest.mark.asyncio
async def test_multi_select_responses_reject_invalid_values_and_store_typed_arrays(
    client, db, seed_study, participant_headers
):
    question = {
        "id": "multi",
        "type": "multi_select",
        "text": "Welche Maßnahmen?",
        "options": [{"value": 1, "label": "Zahl"}, {"value": "1", "label": "Text"}],
    }
    questionnaire = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.pre_test,
        title="PCK",
        questions=[question, {**question, "id": "optional", "required": False}],
    )
    db.add(questionnaire)
    await db.flush()
    path = f"/participant/questionnaires/{questionnaire.id}/respond"
    for invalid in ([], [1, 1], ["unknown"], 1, "1", None, [True], {}):
        response = await client.post(
            path, headers=participant_headers, json={"answers": {"multi": invalid}}
        )
        assert response.status_code == 422
    response = await client.post(
        path, headers=participant_headers, json={"answers": {"multi": [1, "1"], "optional": []}}
    )
    assert response.status_code == 201
    for invalid in ([1, 1], None, "1"):
        response = await client.post(
            path, headers=participant_headers, json={"answers": {"multi": [1], "optional": invalid}}
        )
        assert response.status_code == 422
    stored = await db.scalar(
        select(QuestionnaireResponse).where(
            QuestionnaireResponse.questionnaire_id == questionnaire.id
        )
    )
    assert stored.answers == {"multi": [1, "1"], "optional": []}
