// Dealer Portal (zyansaber/dealertest2) production-planning board, bundled unchanged so Orderdesk
// shows exactly the SRV/SRM dates the Portal computes. Rebuild: scripts/build-portal-board.sh
import { boardVehiclesFromSources } from "@/pages/productionPlanning/sources";
import { buildProductionBoard, DEFAULT_BOARD_SETTINGS } from "@/pages/productionPlanning/board";
export { boardVehiclesFromSources, buildProductionBoard, DEFAULT_BOARD_SETTINGS };
