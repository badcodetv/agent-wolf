import { Box, Container, Typography } from "@mui/material";
import { Line, LineChart, ResponsiveContainer } from "recharts";

// Placeholder scoreboard-shaped data, just enough to prove Recharts is wired
// end to end (installed, typechecks, renders). Real chart components land
// with the hypothesis-detail page in a later ticket.
const placeholderSeries = [
  { day: 0, value: 0 },
  { day: 1, value: 0 },
];

export function App() {
  return (
    <Container maxWidth="sm">
      <Box sx={{ py: 8, textAlign: "center" }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Agent Wolf
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Scaffold — hypothesis pages land in later tickets. See
          design/2026-08-20-agent-wolf.md in the agent-orange repo.
        </Typography>
        <Box sx={{ mt: 4, height: 80 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={placeholderSeries}>
              <Line type="monotone" dataKey="value" stroke="#1976d2" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Box>
      </Box>
    </Container>
  );
}
