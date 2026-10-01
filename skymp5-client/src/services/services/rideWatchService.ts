import { ClientListener, CombinedController, Sp } from "./clientListener";
import { rideWatchTick } from "../../sync/rideWatch";
import { flushPlayerNiNodeUpdate } from "../../sync/niNodeSafe";
import { gmTrace, traceText } from "../../debugTrace";

// ia-forge (BUG-048): dense traces of the horse we ride, see sync/rideWatch.ts.
export class RideWatchService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => {
      try {
        flushPlayerNiNodeUpdate();
        rideWatchTick();
      } catch (e) {
        if (Date.now() - this.lastErrorAt > 5000) {
          this.lastErrorAt = Date.now();
          gmTrace("erreur", `ride watch: ${traceText(e)}`);
        }
      }
    });
  }

  private lastErrorAt = 0;
}
