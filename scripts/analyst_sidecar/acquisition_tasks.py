"""Own parallel source reads for one review, including cancellation cleanup."""
import asyncio


class AcquisitionTasks:
    def __init__(self):
        self.tasks = []

    async def __aenter__(self):
        return self

    def start(self, awaitable):
        task = asyncio.create_task(awaitable)
        self.tasks.append(task)
        return task

    async def __aexit__(self, *_):
        for task in self.tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
