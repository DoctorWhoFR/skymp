import { printConsole } from "@skyrim-platform/skyrim-platform";
import { ClientListener } from "./services/services/clientListener";
import { gmTrace, traceText } from "./debugTrace";

// TODO: redirect this to spdlog
export function logError(service: ClientListener | string, ...rest: unknown[]) {

    const restProcessed = rest.map(item => {
        if (item instanceof Error) {
            return item.stack || item.message;
        }

        return item;
    });

    printConsole(`Error in ${typeof service !== "string" ? service.constructor.name : service}:`, ...restProcessed);
    // ia-forge : les erreurs du client remontent toujours au serveur (mode débogage, catégorie « erreur »).
    gmTrace("erreur", `${typeof service !== "string" ? service.constructor.name : service} : ${restProcessed.map((x) => traceText(x, 800)).join(" ")}`);
}

// TODO: redirect this to spdlog
export function logTrace(service: ClientListener | string, ...rest: unknown[]) {
    const restProcessed = rest.map(item => {
        if (item instanceof Error) {
            return item.stack || item.message;
        }

        return item;
    });

    printConsole(`Trace in ${typeof service !== "string" ? service.constructor.name : service}:`, ...restProcessed);
    // ia-forge : traces de SkyMP vers le mode débogage (catégorie « client »).
    gmTrace("client", `${typeof service !== "string" ? service.constructor.name : service} : ${restProcessed.map((x) => traceText(x, 300)).join(" ")}`);
}
