# Constants that are part of the domain/wire contract rather than deployment
# configuration. Lives here (not infra/settings.py) so models/ can depend on
# it without models -> infra becoming a dependency, and infra/settings.py can
# import it the same way any other consumer does.

SIMULATION_DURATION = 120  # Max simulation duration (minutes) a case can be configured with.
