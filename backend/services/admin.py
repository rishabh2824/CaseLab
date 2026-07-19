# CRUD for the ``admins`` table. Scale is ~20 admins total, so every function here does the simplest possible
# query rather than anything batched/paginated.

from sqlmodel import select
from infra.db_models import Admin


async def getByEmail(session, email: str) -> dict | None:
    admin = (await session.exec(select(Admin).where(Admin.email == email))).first()
    return admin.model_dump(mode="json") if admin else None


async def getById(session, admin_id: int) -> dict | None:
    admin = await session.get(Admin, admin_id)
    return admin.model_dump(mode="json") if admin else None


async def listAll(session) -> list[dict]:
    admins = (await session.exec(select(Admin).order_by(Admin.email))).all()
    return [admin.model_dump(mode="json") for admin in admins]


async def create(session, email: str, name: str | None, role: int) -> dict:
    admin = Admin(email=email, name=name, role=role)
    session.add(admin)
    await session.commit()
    await session.refresh(admin)
    return admin.model_dump(mode="json")


async def delete(session, admin_id: int) -> None:
    admin = await session.get(Admin, admin_id)
    if admin is not None:
        await session.delete(admin)
        await session.commit()
