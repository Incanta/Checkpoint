import merge from "lodash.merge";
import { routeRoot } from "./root";
import { routeSubmit } from "./submit";
import { routeFiler } from "./filer";


export function routes() {
  return merge({}, routeRoot(), routeSubmit(), routeFiler());
}
