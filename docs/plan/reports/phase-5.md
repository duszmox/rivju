# Phase 5 follow-up

Fixed merge-request review data staying stale after a verification run settles.
The renderer now performs a final detail refresh when the live event stream has
a terminal status while the cached run is still queued or running. This loads
the completed status and final verification verdicts even though periodic
polling has stopped.

Added a regression test for completed, failed, and cancelled transitions.
There were no architecture deviations or dependency changes.
