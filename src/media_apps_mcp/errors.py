class NotYetSupportedError(Exception):
    """Raised when a tool is called for a service whose integration isn't wired up yet."""

    def __init__(self, service: str, reason: str):
        self.service = service
        super().__init__(f"{service} is not yet supported here: {reason}")
