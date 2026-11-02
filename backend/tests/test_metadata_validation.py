import pytest
from pydantic import ValidationError

from app.api.admin.videos import VideoFinalizeRequest
from app.schemas.admin import StudyCreate, StudyUpdate, VideoUpdate
from app.services import storage


@pytest.mark.parametrize("value", ["", "  ", "x" * 256, None, True, 17, {}, []])
@pytest.mark.parametrize(
    "schema,field",
    [
        (StudyCreate, "name"),
        (StudyUpdate, "name"),
        (VideoUpdate, "title"),
        (VideoFinalizeRequest, "title"),
    ],
)
def test_metadata_title_rejected(schema, field, value):
    with pytest.raises(ValidationError):
        schema(
            **{
                field: value,
                **({"object_name": "a" * 32 + ".mp4"} if schema is VideoFinalizeRequest else {}),
            }
        )


@pytest.mark.parametrize("value", [-1, 2**31, 1.5, True, "30", {}, []])
@pytest.mark.parametrize("schema", [VideoUpdate, VideoFinalizeRequest])
def test_video_timer_rejected(schema, value):
    with pytest.raises(ValidationError):
        schema(
            **{
                "time_limit_seconds": value,
                **(
                    {"title": "A", "object_name": "a" * 32 + ".mp4"}
                    if schema is VideoFinalizeRequest
                    else {}
                ),
            }
        )


def test_omission_and_nullable_timer_are_distinct():
    assert StudyUpdate().model_dump(exclude_unset=True) == {}
    assert VideoUpdate().model_dump(exclude_unset=True) == {}
    assert VideoUpdate(time_limit_seconds=None).model_dump(exclude_unset=True) == {
        "time_limit_seconds": None
    }
    assert StudyUpdate(name="  Study  ").name == "Study"
    assert VideoUpdate(title="  Clip  ").title == "Clip"
    for schema in (StudyUpdate, VideoUpdate):
        for field in schema.model_fields:
            if field == "time_limit_seconds":
                continue
            with pytest.raises(ValidationError):
                schema(**{field: None})


async def test_invalid_study_updates_are_atomic(client, seed_study, admin_headers):
    url = f"/admin/studies/{seed_study.id}"
    before = (await client.get(url, headers=admin_headers)).json()
    for body in [
        {"name": ""},
        {"name": "x" * 256},
        {"texts": None},
        {"video_defaults": None},
        {"description": None},
        {"sosci_id_param": "x" * 65},
        {"sosci_pretest_url": "x" * 1001},
        {"sosci_posttest_url": "x" * 1001},
    ]:
        response = await client.patch(url, json={**body, "is_active": False}, headers=admin_headers)
        assert response.status_code == 422, response.text
        assert (await client.get(url, headers=admin_headers)).json() == before
    response = await client.patch(url, json={"name": "ü" * 255}, headers=admin_headers)
    assert response.status_code == 200


async def test_upload_rejects_metadata_before_writing_files(
    client, seed_study, admin_headers, tmp_path, monkeypatch
):
    monkeypatch.setattr(storage, "UPLOADS", tmp_path)
    url = f"/admin/studies/{seed_study.id}/videos"
    mp4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 32
    for data in [
        {"title": "  "},
        {"title": "x" * 256},
        {"title": "Clip", "time_limit_seconds": "-1"},
        {"title": "Clip", "time_limit_seconds": "1.5"},
        {"title": "Clip", "time_limit_seconds": str(2**31)},
    ]:
        response = await client.post(
            url, data=data, files={"file": ("test.mp4", mp4, "video/mp4")}, headers=admin_headers
        )
        assert response.status_code == 422, response.text
        assert not list(tmp_path.rglob("*"))
        assert (await client.get(url, headers=admin_headers)).json() == []
    response = await client.post(
        url,
        data={"title": "  Clip  ", "time_limit_seconds": "0"},
        files={"file": ("test.mp4", mp4, "video/mp4")},
        headers=admin_headers,
    )
    assert response.status_code == 201, response.text
    video = response.json()
    assert video["title"] == "Clip" and video["time_limit_seconds"] == 0
    for body in [
        {"title": ""},
        {"title": None},
        {"time_limit_seconds": -1},
        {"time_limit_seconds": True},
        {"info_text": None},
    ]:
        response = await client.patch(
            f"/admin/videos/{video['id']}", json=body, headers=admin_headers
        )
        assert response.status_code == 422
        assert (await client.get(url, headers=admin_headers)).json() == [video]
    assert (
        await client.patch(
            f"/admin/videos/{video['id']}", json={"time_limit_seconds": None}, headers=admin_headers
        )
    ).status_code == 200
